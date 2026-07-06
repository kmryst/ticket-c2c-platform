#!/usr/bin/env bash
# destroy 後の残存リソース確認（staging-environment.md「destroy 後確認」）。
# 指定 prefix の高コスト・常時課金リソースが AWS 側に残っていたら非 0 で終了する。
# CloudWatch Logs / ECR image / S3 state bucket は意図的に残すため対象外。
#
# Usage: check-residual-resources.sh <name-prefix>   # 例: ticket-c2c-staging

set -euo pipefail

prefix="${1:?usage: check-residual-resources.sh <name-prefix>}"
region="${AWS_REGION:-ap-northeast-1}"
found=0

report() {
	local kind="$1"
	local ids="$2"

	if [[ -n $ids && $ids != "None" ]]; then
		echo "RESIDUAL ${kind}: ${ids}"
		found=1
	else
		echo "ok: no residual ${kind}"
	fi
}

# ALB / Target Group
report "ALB" "$(aws elbv2 describe-load-balancers --region "$region" \
	--query "LoadBalancers[?starts_with(LoadBalancerName, '${prefix}')].LoadBalancerName" --output text)"
report "Target Group" "$(aws elbv2 describe-target-groups --region "$region" \
	--query "TargetGroups[?starts_with(TargetGroupName, '${prefix}')].TargetGroupName" --output text)"

# NAT Gateway（deleted / deleting は残存扱いにしない）
report "NAT Gateway" "$(aws ec2 describe-nat-gateways --region "$region" \
	--filter "Name=tag:Name,Values=${prefix}*" "Name=state,Values=pending,available" \
	--query 'NatGateways[].NatGatewayId' --output text)"

# Elastic IP
report "Elastic IP" "$(aws ec2 describe-addresses --region "$region" \
	--filters "Name=tag:Name,Values=${prefix}*" \
	--query 'Addresses[].AllocationId' --output text)"

# RDS / Aurora
report "Aurora cluster" "$(aws rds describe-db-clusters --region "$region" \
	--query "DBClusters[?starts_with(DBClusterIdentifier, '${prefix}')].DBClusterIdentifier" --output text)"
report "RDS instance" "$(aws rds describe-db-instances --region "$region" \
	--query "DBInstances[?starts_with(DBInstanceIdentifier, '${prefix}')].DBInstanceIdentifier" --output text)"

# ElastiCache / Valkey
report "ElastiCache replication group" "$(aws elasticache describe-replication-groups --region "$region" \
	--query "ReplicationGroups[?starts_with(ReplicationGroupId, '${prefix}')].ReplicationGroupId" --output text)"

# OpenSearch
report "OpenSearch domain" "$(aws opensearch list-domain-names --region "$region" \
	--query "DomainNames[?starts_with(DomainName, '${prefix}')].DomainName" --output text)"

# EventBridge Scheduler schedule（L-9 残課題 / Issue #195。課金は起動時のみだが、
# destroy 漏れがあれば孤立した ECS RunTask 定期実行が残り続けるため検出対象にする）。
report "EventBridge Scheduler schedule" "$(aws scheduler list-schedules --region "$region" \
	--query "Schedules[?starts_with(Name, '${prefix}')].Name" --output text)"

# ECS cluster / service（cluster 名一致で判定）
ecs_clusters="$(aws ecs list-clusters --region "$region" --query 'clusterArns' --output text |
	tr '\t' '\n' | awk -F'/' -v p="$prefix" '$NF ~ "^"p {print $NF}' | tr '\n' ' ')"
report "ECS cluster" "${ecs_clusters% }"

# VPC と Interface VPC Endpoint（VPC が残っていれば endpoint も含めて検出する）
vpc_ids="$(aws ec2 describe-vpcs --region "$region" \
	--filters "Name=tag:Name,Values=${prefix}*" --query 'Vpcs[].VpcId' --output text)"
report "VPC" "$vpc_ids"
if [[ -n $vpc_ids && $vpc_ids != "None" ]]; then
	for vpc_id in $vpc_ids; do
		report "Interface VPC Endpoint (${vpc_id})" "$(aws ec2 describe-vpc-endpoints --region "$region" \
			--filters "Name=vpc-id,Values=${vpc_id}" "Name=vpc-endpoint-type,Values=Interface" \
			--query 'VpcEndpoints[].VpcEndpointId' --output text)"
	done
fi

if [[ $found -ne 0 ]]; then
	echo "residual resources found for prefix '${prefix}'" >&2
	exit 1
fi

echo "no residual billable resources for prefix '${prefix}'"
