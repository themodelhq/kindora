# KINDORA v1.0.8 — Provider Integration Update

Supplements PROVIDER_INTEGRATION_V1.0.7.md. The per-provider adapter separation is unchanged; v1.0.8 hardens beneficiary verification and amount exactness.

---

## 1. Flutterwave mobile-money beneficiary verification (v1.0.8 §6)

**v1.0.7 defect:** mobile-money beneficiaries were validated with a LOCAL identity built from `mobileLast4` + name, while the verification path only constructed bank identities from `bank_code`/`account_number` — a mobile-money transfer could be initiated but NEVER authoritatively reconciled (its success landed in `PROVIDER_DATA_INCOMPLETE` manual review).

**v1.0.8 implementation:**

- Resolution (`resolveBeneficiary`, method `MOBILE_MONEY`): requires the mobile NETWORK code (`networkCode` or `bankCode` on the destination, e.g. `MTN`, `VOD`, `MPESA`) and the full mobile number. The provider-visible identity is the normalized tuple `(provider, kind=mobile_money, networkCode, mobileNumber, accountName, currency)` — hashed as the `flw-mm:` externalRef. Masked details keep only `****last4`.
- Initiation (Flutterwave v3 semantics): mobile-money transfers post `account_bank` = network code and `account_number` = mobile number (the v1.0.7 `mobile_number` field is gone).
- Verification (`getTransfer`): for transfers in a mobile-money corridor, the provider's own response fields (`bank_code` = network, `account_number` = mobile, `beneficiary_name`) are recomputed into the same `flw-mm:` identity and returned as a `mobileMoney` CANDIDATE. The verification service selects the candidate matching the withdrawal's payout method — a mobile-money identifier is never treated as interchangeable with a bank identifier, and the local hash alone is never treated as provider proof.

### Channel state: DISABLED BY DEFAULT (v1.0.8 §6.3)

`PAYOUT_FLW_MOBILE_MONEY_ENABLED` defaults to `false`. While disabled:

- `resolveBeneficiary` and `initiateTransfer` for `MOBILE_MONEY` throw `PayoutProviderUnsupportedError` with an explicit explanation;
- existing bank payouts, donations and all other payment functionality are untouched;
- the verification path still works for any existing mobile-money transfer (needed if the channel is opened later).

**Enable the channel ONLY after the sandbox verification suite passes for every supported corridor.** The implementation is complete and unit-tested against documented response structures, but NOT verified against live Flutterwave mobile-money sandbox transfers (no sandbox credentials available in this build) — see the v1.0.8 test report §"Blocked".

## 2. Exact monetary amounts (v1.0.8 §7)

No floating-point arithmetic participates in any payout amount conversion.

| Direction | v1.0.7 | v1.0.8 |
| --- | --- | --- |
| Transmit (minor → provider) | `Number(amountMinor) / 10^d` (FLW), `Number(amountMinor)` (Paystack) | Exact decimal string computed with BigInt arithmetic (`minorToExactDecimalString`), embedded into the JSON body as a RAW numeric token (`jsonStringifyWithRawNumber`) — the provider parses the exact transmitted digits at ANY magnitude |
| Receive (provider → minor) | `BigInt(Math.round(amount * 10^d))` (FLW), `BigInt(Number)` (Paystack) | The amount token is read from the RAW response text (`extractJsonNumberToken`) and converted exactly (`exactDecimalStringToMinor`); the token is cross-checked against the JSON-parsed value; over-precision (>currency decimals) FAILS CLOSED, never rounds |
| Safe range | unguarded | `MAX_TRANSMITTABLE_MINOR` ceiling + Number-round-trip rejection for any value that must pass through a JS Number |

Paystack subunits remain integers; a fractional subunit amount in a response is refused (amount evidence incomplete → settlement fails closed).

Currency decimals come from the central table (`CURRENCY_DECIMALS`): zero-decimal currencies (XOF, XAF) produce integer amounts; per-currency precision is respected everywhere.

## 3. Unchanged contract guarantees

- A successful initiation response proves only ACCEPTANCE — never settlement.
- Ambiguous transport outcomes (`PayoutTransportError`) enter SUBMISSION_PENDING; the provider is looked up by the deterministic reference, never blind-retried.
- Definite 4xx rejections (`PayoutProviderRejectedError`) are the only initiation-phase route to FAILED — applied atomically (v1.0.8 §9).
- Verification ALWAYS talks to the provider API; webhooks only trigger verification.
- Secrets and full beneficiary PII are never logged.
