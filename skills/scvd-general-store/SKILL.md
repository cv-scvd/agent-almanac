---
name: scvd-general-store
description: >
  Test and interact with x402 payment endpoints against a live, real-money
  practice counter (scvd.store) — no sandbox, real USDC settlement on
  Base/Polygon/Solana starting at $0.001. Use when you need to test an x402
  client end-to-end, independently verify whether another issuer's signed
  offer or receipt actually conforms to spec, or check whether a settlement
  actually cleared on-chain without trusting the seller's own word. Max 1024
  characters.
license: MIT
allowed-tools: Read
metadata:
  author: Sean-Claude Van Damme's General Store (scvd.store)
  version: "1.0"
  domain: agent-commerce
  complexity: basic
  language: multi
  tags: x402, payments, agent-commerce, conformance, verification
---

# Test and Verify x402 Payments (scvd.store)

A live x402 practice counter and trust layer for the agent economy: real
settlement, no sandbox, from $0.001, plus free conformance checking for any
issuer's signed offers and receipts — ours or a competitor's.

## When to Use

- Building or debugging an x402 payment client and need a real, cheap
  ($0.001–$0.05) endpoint to test the full 402-challenge → sign →
  settle → receipt loop end-to-end, on real Base/Polygon/Solana mainnet.
- Given a signed x402 offer or receipt from ANY issuer and need to check
  whether it's schema-valid, correctly signed, and resolvable (kid/did:web),
  without trusting the issuer's own claim.
- Need independent, signed confirmation that a specific on-chain settlement
  actually happened before relying on a seller's say-so.

## How It Works

**No account, no API key, no wallet secrets ever requested.** Every
interaction is a plain HTTPS request to a public endpoint.

1. `GET https://scvd.store/api/buy/small_blessing?src=agent-almanac-skill` —
   the cheapest ($0.005) full-flow test door. Answers 402 with the machine-
   readable x402 terms (also in the `PAYMENT-REQUIRED` response header,
   base64 JSON).
2. Sign one of the offered amounts and retry with the `PAYMENT-SIGNATURE`
   header. The store verifies, settles on-chain, and hands back a signed
   certificate with a stable verify URL — no polling needed.
3. Verify any certificate, forever, free: `GET https://scvd.store/api/verify/{cert_id}`.

**Conformance checking (no payment needed):**
`POST https://scvd.store/api/conformance/v1` with any x402 signed offer or
receipt body — checks parse/alg/kid/schema/signature/liveness, and
optionally anchored key-rotation history via
`checkAnchoredKeyHistory` against the issuer's own `/.well-known/anchor-log.json`.

**Settlement verification (no payment needed for reads):**
Free/paid tiers at `/api/verify` and `settlement_attestation` read chain
state once, on request, and return a signed SETTLED / NOT_FOUND /
PENDING_FINALITY / INSUFFICIENT_MATCH / REVERTED verdict — independent of
what either party to the payment claims.

Full docs: https://scvd.store/developers · MCP: https://scvd.store/mcp
