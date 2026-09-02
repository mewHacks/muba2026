# SHOU — Design System & Architecture Specification

## 1. Overview & Vision
**SHOU** (守 — *to guard, to protect*) is a safe stablecoin remittance and elder protection protocol on the **Sui Network**. It bridges real-time social-engineering scam detection with on-chain conditional escrow to protect non-crypto seniors receiving family remittances.

The design language pairs **retro-computing pixel aesthetics** with **high-contrast typography and senior-first accessibility layouts**.

---

## 2. Visual Identity & Design System

### 2.1 Color Palette
- **Canvas Base**: `#FFFFFF` (Clean, crisp white)
- **Secondary Surfaces**: `slate-50` (`#F8FAFC`) / `slate-100` (`#F1F5F9`)
- **Borders & Dividers**: `slate-200` (`#E2E8F0`) / `slate-900` (`#0F172A`)
- **Brand Electric Blue**: `#3898FF` (Sui network accent)
- **High-Contrast Text**:
  - Primary text: `slate-900` (`#0F172A`)
  - Subdued / Secondary: `slate-600` (`#475569`)
  - Muted code / metadata: `slate-500` (`#64748B`)
- **Semantic State Colors**:
  - Danger / Blocked: `rose-600` (`#E11D48`), background `rose-50`
  - Safe / Passed: `emerald-600` (`#059669`), background `emerald-50`
  - Warning / Co-sign: `amber-600` (`#D97706`), background `amber-50`

### 2.2 Typography Pairings
1. **Display & Headings**: `Pixel Display` (`VT323`, `monospace`)
   - Evokes cryptographic rigor, terminal nostalgia, and punchy arcade scannability.
2. **Body & Interface**: `Outfit` / `Inter` (`font-classy`)
   - High legibility, open counters, accessible line-height (`1.5–1.6`).
3. **Bytecode & Payloads**: `JetBrains Mono` / `Space Mono` (`font-mono-code`)
   - Monospaced formatting for Move bytecode, gas budgets, and addresses.

### 2.3 Pixel-Art Visual Motifs
- **Corner Brackets**: Monospaced pixel indicators (`::`) in container corners.
- **Hard Pixel Drop Shadows**: `shadow-[3px_3px_0px_#3898FF]` or `shadow-[3px_3px_0px_#000000]`.
- **Wireframe & Isometric Geometric Vectors**:
  - `WireframeMagnifier`: Smart object simulation icon.
  - `PixelStairCube`: Adaptive workflows step-structure.
  - `WireframeStar`: Zero-drain verification emblem.
  - `PixelBurstFlower`: Sui Agent 004 security node visual.

---

## 3. Core Functional Components

### 3.1 Navbar & Live Status Ticker
- Brand lockup with Sui water-drop logo and `#3898FF` accent.
- Live RPC latency indicator (`18ms // SUI MAINNET`).
- Direct action triggers: **Test Simulator** and **Guardian Policy Setup**.

### 3.2 Hero Section
- **Grant & Foundation Badge**: Sui Foundation endorsement tag.
- **Punchy Headline**: Dual-tone pixel header emphasizing anti-drainer security.
- **Dual Verification Cards**: Pre-sign balance previews and guardian co-signing.
- **Live Metrics Counter**: Blocked attack tally with on-chain telemetry.

### 3.3 Protocol Gateway Bento Grid
- **Sui Move Escrow Sandbox Card**: High-contrast terminal previewing `SeniorityPolicy` and `TransferRequest<USDC>` state transitions.
- **Two-Step Architecture**:
  1. `// 001 OFF-CHAIN RISK SCORING`: Gonka Router 3-model consensus producing Truth Score + Request ID.
  2. `// 002 ON-CHAIN MOVE ESCROW`: Deterministic policy escalation, cooldown time-locks, and M-of-N guardian approval.

### 3.4 Interactive Elder Scam & Escrow Simulator
- **Scenario Selector Tabs**: Real-world elder social engineering vectors:
  - **Police / Bank Impersonation** (Urgent coercive demand $\rightarrow$ 🔴 High Risk $\rightarrow$ M-of-N Guardian Hold)
  - **Romance & Secrecy Scam** ("Don't tell your family" $\rightarrow$ 🔴 High Risk $\rightarrow$ Circuit Breaker lock)
  - **Unfamiliar Large Transfer** (Over elder's ceiling $\rightarrow$ 🟡 Medium Risk $\rightarrow$ 24h Cooldown Delay)
  - **Community Flagged Address** (Matched on `DenyList` $\rightarrow$ 🚫 Hard Block)
  - **Normal Family Remittance** (Known recipient $\rightarrow$ 🟢 Low Risk $\rightarrow$ Instant Atomic PTB)
- **Move Policy Inspector**: Visualizes `TransferRequest<USDC>` object state, unlock timestamps, and required guardian signatures.
- **Plain-English Voice Warning**: Uses the Web Speech API (`SpeechSynthesisUtterance`) to read warnings aloud in plain, comforting language (English / Malay / Chinese).
- **Invariants Engine**: Live checklist showing which policy invariant triggered (Amount Ceiling, Session Correlation, or Denylist).

### 3.5 Key Value Bento Architecture
- 3-column modular bento cards:
  - `Passive Stream Scoring` (`// 001` — Gonka 3-model consensus, zero victim friction)
  - `Conditional Move Escrow` (`// 002` — On-chain cooling-off & M-of-N co-signing)
  - `Cryptographic Privacy` (`// 003` — TEE / Hash-anchoring, raw chats never exposed)

### 3.6 Ecosystem & Alliances
- Verified partner badges (Mysten Labs, Sui Foundation, Cetus AMM, OtterSec).
- Pixel burst emblem representing Sui Security Agent 004.

---

## 4. Accessibility & Senior User Experience (UX)
- **High Contrast**: Meets WCAG AAA contrast ratios with bold dark text on crisp light surfaces.
- **Spacious Hit Targets**: Minimum 44px clickable areas for buttons and inputs.
- **Audio Redundancy**: Visual warnings paired with plain-English text-to-speech.
- **Zero Jargon**: Complex Move bytecodes (`0x2::coin::transfer`) translated to clear warnings (e.g., *"This site is attempting to drain all your coins"*).
