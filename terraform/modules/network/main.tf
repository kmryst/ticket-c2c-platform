data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  azs                     = slice(data.aws_availability_zones.available.names, 0, var.az_count)
  extra_nat_gateway_count = var.nat_gateway_mode == "per_az" ? var.az_count - 1 : 0
}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "${var.name}-vpc" }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = { Name = "${var.name}-igw" }
}

resource "aws_subnet" "public" {
  count = var.az_count

  vpc_id                  = aws_vpc.this.id
  availability_zone       = local.azs[count.index]
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index)
  map_public_ip_on_launch = true

  tags = { Name = "${var.name}-public-${local.azs[count.index]}" }
}

resource "aws_subnet" "private" {
  count = var.az_count

  vpc_id            = aws_vpc.this.id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, count.index + 100)

  tags = { Name = "${var.name}-private-${local.azs[count.index]}" }
}

# dev / staging 通常時はコスト優先で NAT Gateway を 1 つに絞る。
# staging の capacity_profile=full / prod 相当検証では AZ ごとに配置する。
resource "aws_eip" "nat" {
  domain = "vpc"

  tags = { Name = "${var.name}-nat" }
}

resource "aws_eip" "nat_extra" {
  count = local.extra_nat_gateway_count

  domain = "vpc"

  tags = { Name = "${var.name}-nat-${local.azs[count.index + 1]}" }
}

resource "aws_nat_gateway" "this" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id

  tags = { Name = "${var.name}-nat" }

  depends_on = [aws_internet_gateway.this]
}

resource "aws_nat_gateway" "extra" {
  count = local.extra_nat_gateway_count

  allocation_id = aws_eip.nat_extra[count.index].id
  subnet_id     = aws_subnet.public[count.index + 1].id

  tags = { Name = "${var.name}-nat-${local.azs[count.index + 1]}" }

  depends_on = [aws_internet_gateway.this]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }

  tags = { Name = "${var.name}-public" }
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.this.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.this.id
  }

  tags = { Name = "${var.name}-private" }
}

resource "aws_route_table" "private_extra" {
  count = local.extra_nat_gateway_count

  vpc_id = aws_vpc.this.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.extra[count.index].id
  }

  tags = { Name = "${var.name}-private-${local.azs[count.index + 1]}" }
}

resource "aws_route_table_association" "public" {
  count = var.az_count

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "private" {
  count = var.az_count

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = var.nat_gateway_mode == "per_az" && count.index > 0 ? aws_route_table.private_extra[count.index - 1].id : aws_route_table.private.id
}

# ECR API / Logs は NAT Gateway 経由にする（ADR-0019）。イメージレイヤー本体は
# 元々この S3 Gateway Endpoint（無料）経由で配信されており、Interface Endpoint
# （ecr.api / ecr.dkr / logs）が担っていたのは認証・マニフェスト等の制御プレーン
# 通信のみだった。dev/staging の実測トラフィックは損益分岐点（1.355 GB/稼働時間）
# の約 1/100 で、Interface Endpoint の固定費がその制御プレーン分の NAT 転送費を
# 大きく上回っていたため撤去した（Issue #313 / #315）。
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = concat([aws_route_table.private.id], aws_route_table.private_extra[*].id)

  tags = { Name = "${var.name}-vpce-s3" }
}
