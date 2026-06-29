export type PurchaseStatus = 'confirmed' | 'rejected';

export interface PurchaseRequestBody {
  buyerId?: unknown;
  quantity?: unknown;
  requestId?: unknown;
}

export interface ParsedPurchaseInput {
  eventId: string;
  buyerId: string;
  quantity: number;
  requestId?: string;
}

export interface PurchaseResult {
  purchaseId: string;
  eventId: string;
  buyerId: string;
  quantity: number;
  status: PurchaseStatus;
  rejectionReason: string | null;
  remainingQuantity: number | null;
}
