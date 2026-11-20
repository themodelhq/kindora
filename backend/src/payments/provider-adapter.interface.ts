import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface InitializeInput {
  donationId: string;
  publicRef: string;
  amountMinor: bigint;
  totalMinor: bigint;
  currency: string;
  campaignTitle: string;
  donorEmail: string;
  donorName?: string;
  callbackUrl: string;
  metadata?: Record<string, string>;
}

export interface InitializeResult {
  redirectUrl: string;
  providerReference: string;
}

export type ProviderVerifyStatus = 'succeeded' | 'pending' | 'failed';

export interface VerifyResult {
  status: ProviderVerifyStatus;
  providerReference: string;
  providerFeeMinor?: bigint;
  /**
   * Provider-reported charged amount in MINOR units. Live providers MUST
   * populate this on success so the payment layer can prove that the amount
   * the provider captured equals the amount the donor was shown. A missing
   * amount on a live success is treated as unverifiable (never trusted).
   */
  amountMinor?: bigint;
  /** Provider-reported charged currency (ISO-4217), used for currency equality checks. */
  currency?: string;
  /**
   * Provider token for the saved payment authorization (e.g. Paystack
   * `authorization.authorization_token`). Captured on success so recurring
   * schedules can charge off-session later. Never raw card data.
   */
  chargeAuthorization?: string;
  raw?: Record<string, unknown>;
}

/** Coarse classification used to route webhook events safely. */
export type ProviderEventClass = 'SUCCESS' | 'TERMINAL_FAILURE' | 'REFUND' | 'DISPUTE' | 'PAYOUT_TRANSFER' | 'UNKNOWN';

export interface WebhookVerifyResult {
  valid: boolean;
  eventId?: string;
  eventType?: string;
  reference?: string;
  /** Provider-reported transaction status (e.g. Flutterwave `data.status`). */
  dataStatus?: string;
  /** Provider-reported amount in MINOR units when the payload carries one. */
  amountMinor?: bigint;
  /** Provider-reported currency when the payload carries one. */
  currency?: string;
}

export interface PaymentProviderAdapter {
  readonly name: string;
  isEnabled(): boolean;
  initialize(input: InitializeInput): Promise<InitializeResult>;
  verify(reference: string): Promise<VerifyResult>;
  verifyWebhook(rawBody: Buffer | string, headers: Record<string, string | string[] | undefined>): Promise<WebhookVerifyResult>;
  /** Provider-side refund execution (live providers implement; mock included for tests). */
  refund?(providerReference: string, amountMinor: bigint): Promise<{ providerRef: string }>;
}

/**
 * Authoritative TRANSFER (payout) verification — v1.0.4 §5.1. Implemented by
 * providers that support transfers (Paystack, Flutterwave) plus the test
 * mock. Result is a raw provider status string; classification into
 * SUCCESSFUL/FAILED/PENDING/UNKNOWN/REVERSED happens exclusively in
 * PayoutService via classifyTransferStatus (UNKNOWN is never collapsed to
 * FAILED).
 */
export interface TransferVerifyResult {
  providerStatus: string | null;
  providerReference: string | null;
  amountMinor?: bigint;
  currency?: string;
  destinationRef?: string;
  /** Verifiable transfer existence flag — false when the provider knows nothing about the reference. */
  exists: boolean;
}

export interface PayoutTransferVerifier {
  /** Read-only GET against the provider's transfer API. Never initiates money movement. */
  verifyTransfer(referenceOrId: string): Promise<TransferVerifyResult>;
}

/** Reusable import shim so adapters keep working without Nest runtime DI. */
export interface ProviderAdapterDeps {
  config: ConfigService;
}

@Injectable()
export abstract class BaseProviderAdapter implements PaymentProviderAdapter {
  abstract readonly name: string;
  protected readonly config: ConfigService;
  constructor(config: ConfigService) {
    this.config = config;
  }
  abstract isEnabled(): boolean;
  abstract initialize(input: InitializeInput): Promise<InitializeResult>;
  abstract verify(reference: string): Promise<VerifyResult>;
  abstract verifyWebhook(
    rawBody: Buffer | string,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<WebhookVerifyResult>;
}
