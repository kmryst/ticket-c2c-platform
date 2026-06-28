# Technology Stack Draft

## Status

Draft.

This document records the current technology stack direction for the C2C ticket marketplace system design exercise. It is not an implementation plan, ADR, or final decision.

## Target System

The system is a C2C ticket marketplace where a user can act as both Buyer and Seller.

In scope:

- Search events by location, event type, and event date.
- Allow future expansion of search conditions.
- Display matching events.
- Purchase event tickets.

Out of scope:

- Payment processing.
- Purchase cancellation.
- Search by price or capacity.
- Buyer/Seller messaging.

Key constraints:

- Up to 5 million users.
- Popular events may receive around 100x normal traffic.
- Traffic concentration on a popular event should not degrade other events.
- Ticket reservations must not exceed available inventory.
- Search and purchase are expected to happen around 10x more often than event listing.

## Recommended Stack

| Layer | Recommendation |
|---|---|
| Frontend | Next.js / React / TypeScript |
| API Entry | CloudFront + WAF + API Gateway or ALB |
| Backend | NestJS / TypeScript |
| API Style | REST + OpenAPI |
| Runtime | ECS Fargate |
| Primary DB | Aurora PostgreSQL |
| Search | OpenSearch |
| Cache / Inventory Front Filter | ElastiCache Valkey |
| Queue | SQS Standard, with SQS FIFO only where per-event purchase ordering is required |
| Event Bus | EventBridge |
| Search Sync | EventBridge + Lambda to OpenSearch |
| Infrastructure | Terraform |
| CI/CD | GitHub Actions |
| Observability | CloudWatch + OpenTelemetry/ADOT + X-Ray |

## Design Direction

Aurora PostgreSQL is the system of record for users, events, ticket inventory, and purchases. Purchase finalization should use database transactions and conditional updates to prevent over-selling.

OpenSearch should serve event search because the required filters include location, event type, event date, and likely future query dimensions. Aurora remains the source of truth, while OpenSearch is a read-optimized projection.

Valkey should be used in front of the purchase flow as a fast inventory filter, especially for popular events. It should reject sold-out requests before they reach Aurora. Valkey is not the final source of truth.

SQS Standard is appropriate for general asynchronous work. SQS FIFO can be introduced only for purchase paths that require per-event ordering or rate control, using `eventId` as the message group key.

EventBridge should publish domain events such as `EventListed`, `EventUpdated`, `InventoryChanged`, and `TicketPurchased`. Search indexing can subscribe to these events and update OpenSearch asynchronously.

REST + OpenAPI is preferred initially because the scope is straightforward, operationally simple, cache-friendly, and easy to observe. GraphQL can be reconsidered later as a BFF layer if the frontend query shape becomes complex.

## Purchase Flow Direction

The purchase path should be designed to protect both correctness and throughput.

1. Buyer sends a purchase request.
2. API layer applies authentication, rate limits, and basic validation.
3. Backend checks/decrements a Valkey inventory counter for fast rejection.
4. If stricter per-event serialization is required, enqueue to SQS FIFO with `MessageGroupId = eventId`.
5. Worker or backend finalizes the purchase in Aurora PostgreSQL with a conditional inventory update.
6. Publish `TicketPurchased` or `InventoryChanged` through EventBridge.
7. Downstream consumers update OpenSearch and other read models.

Final inventory correctness must be guaranteed by Aurora PostgreSQL. Valkey and SQS exist to reduce load, smooth spikes, and isolate popular-event traffic.

## Search Flow Direction

The search path should be optimized separately from the write path.

1. Buyer searches by location, event type, event date, and future filters.
2. API routes search requests to the search service/backend.
3. Backend queries OpenSearch for matching event IDs and summary data.
4. Frequently requested search results may be cached where appropriate.
5. Aurora is used for source-of-truth reads only when necessary.

This separation supports the requirement that search and purchase are much more frequent than event listing.

## Review Notes From Claude Code

Claude Code reviewed the initial stack direction and considered it generally appropriate.

Main concerns raised:

- API Gateway or ALB should be explicit as the API entry and throttling layer.
- Aurora-only inventory updates are correct but may become a hot-row bottleneck for popular events.
- Popular-event purchase spikes can consume Aurora connections, CPU, or I/O and affect other events.
- OpenSearch synchronization from Aurora should be described explicitly.

Recommended adjustments from the review:

- Add Valkey as a fast inventory filter before Aurora.
- Use SQS FIFO only where event-level purchase serialization is needed.
- Keep Aurora PostgreSQL as the final source of truth.
- Add EventBridge + Lambda as the simple initial path for OpenSearch updates.
- Consider Aurora Reader Endpoint for read separation where useful.

## Open Questions

- Should the API entry be API Gateway or ALB for the first design diagram?
- Should purchase finalization be synchronous after Valkey, or asynchronous through SQS FIFO for all high-demand events?
- What consistency delay is acceptable between Aurora and OpenSearch?
- Should authentication be Cognito or an external provider such as Auth0?
- Do we need a separate inventory service from the beginning, or only after the NestJS backend becomes a bottleneck?

