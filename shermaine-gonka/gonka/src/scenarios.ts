import type { TxContext, Language, RiskTier } from "./types.js";

export interface Case {
  id: string;
  label: string;
  language: Language;
  message: string;
  tx: TxContext;
  expected: RiskTier;
  /** Deliberately hard: adversarial or borderline. These are where judges probe. */
  hard?: boolean;
}

const tx = (
  amountMYR: number,
  recipientLabel: string,
  recipientIsNew: boolean,
  opts: Partial<TxContext> = {},
): TxContext => ({
  amountMYR, recipientLabel, recipientIsNew,
  usualMaxMYR: 150, transfersLastHour: 0, localHour: 14, ...opts,
});

export const EVAL_CASES: Case[] = [
  // ---------- scams ----------
  { id: "macau", label: "Macau scam (Malay)", language: "ms", expected: "HIGH",
    message: "Encik, ini dari PDRM Bukit Aman. Akaun bank encik terlibat dalam kes pengubahan wang haram. Sila pindah RM5000 ke akaun keselamatan 1234567890 SEKARANG JUGA atau kami tangkap encik esok. Jangan beritahu sesiapa termasuk keluarga.",
    tx: tx(5000, "Unknown account", true, { localHour: 22 }) },
  { id: "lhdn", label: "LHDN tax arrears (English)", language: "en", expected: "HIGH",
    message: "This is LHDN. You have unpaid tax arrears and a court summons will be issued today. Settle RM3200 immediately to avoid a warrant. Do not discuss this case with anyone.",
    tx: tx(3200, "Tax settlement", true) },
  { id: "otp", label: "OTP request", language: "en", expected: "HIGH",
    message: "Hi, I am from Maybank security. To reverse the suspicious charge please read me the 6-digit TAC code we just sent to your phone.",
    tx: tx(0, "n/a", false) },
  { id: "seed", label: "Seed phrase request", language: "en", expected: "HIGH",
    message: "Your wallet needs re-verification. Please enter your 12-word recovery phrase on our support page to restore access.",
    tx: tx(0, "n/a", false) },
  { id: "newnumber", label: "Fake family, new number", language: "en", expected: "HIGH",
    message: "Hi mum, this is my new number, my old phone is spoilt. I'm stuck and need to pay something urgently, can you transfer RM1800 now? Don't call the old number.",
    tx: tx(1800, "New payee", true, { localHour: 20 }) },
  { id: "invest", label: "Fake investment (Chinese)", language: "zh", expected: "HIGH",
    message: "阿姨您好，我们的平台保本保息，每月稳定收益 12%，机会有限。今天入金 RM3000 就可以锁定名额，明天就涨价了。",
    tx: tx(3000, "Investment platform", true) },
  { id: "loan", label: "Fake loan processing fee", language: "en", expected: "HIGH",
    message: "Congratulations, your RM50,000 loan is approved. Pay the RM900 processing fee within 2 hours to release the funds today.",
    tx: tx(900, "Loan agent", true) },
  { id: "parcel", label: "Parcel customs fee", language: "en", expected: "MEDIUM",
    message: "Your parcel is held at customs. A clearance fee of RM320 must be paid within 2 hours or it will be returned.",
    tx: tx(320, "Courier fee", true) },
  { id: "love", label: "Love scam", language: "en", expected: "MEDIUM",
    message: "My darling, the bank has frozen my account while I am offshore. I only need RM2500 to clear it and I will repay you the moment I land. Please keep this between us.",
    tx: tx(2500, "Overseas friend", true) },
  { id: "prize", label: "Lucky draw prize", language: "ms", expected: "MEDIUM",
    message: "Tahniah! Anda menang cabutan bertuah RM20,000. Bayar yuran pemprosesan RM250 segera untuk tuntut hadiah anda.",
    tx: tx(250, "Prize processing", true) },
  { id: "job", label: "Task/job scam", language: "en", expected: "MEDIUM",
    message: "Easy part time job, complete simple tasks daily. Top up RM500 to unlock your commission withdrawal.",
    tx: tx(500, "Task platform", true) },
  { id: "charity", label: "Fake charity urgency", language: "en", expected: "MEDIUM",
    message: "Urgent flood relief appeal closing tonight. Donate RM400 now to help families before midnight.",
    tx: tx(400, "Relief fund", true) },

  // ---------- legitimate ----------
  { id: "bill", label: "Legit: electricity bill", language: "en", expected: "LOW",
    message: "Your TNB bill for this month is RM86.40, due on the 15th.",
    tx: tx(86.4, "TNB (saved payee)", false, { localHour: 10 }) },
  { id: "son", label: "Legit: pocket money to son", language: "en", expected: "LOW",
    message: "Ma, can help with RM100 for books this month?",
    tx: tx(100, "Wei Jie (saved, son)", false) },
  { id: "groceries", label: "Legit: groceries", language: "en", expected: "LOW",
    message: "",
    tx: tx(64.2, "Jaya Grocer (saved)", false, { localHour: 11 }) },
  { id: "water", label: "Legit: water bill (Malay)", language: "ms", expected: "LOW",
    message: "Bil air anda bulan ini RM32.10. Sila jelaskan sebelum 20 haribulan.",
    tx: tx(32.1, "Air Selangor (saved)", false) },
  { id: "kopitiam", label: "Legit: small QR payment", language: "en", expected: "LOW",
    message: "",
    tx: tx(12.5, "Kopitiam (new)", true, { localHour: 8 }) },
  { id: "daughter", label: "Legit: repay daughter", language: "zh", expected: "LOW",
    message: "妈，上次帮你买药的钱 RM120，方便的时候转给我就好，不急。",
    tx: tx(120, "Mei Ling (saved, daughter)", false) },

  // ---------- hard: the ones judges will try ----------
  { id: "hospital", label: "HARD legit: real hospital deposit", language: "en", expected: "MEDIUM", hard: true,
    message: "Ma, I'm at the hospital with Pa. They need a RM2000 deposit before admission. Please transfer to the hospital account now, I'll call you after.",
    tx: tx(2000, "Hospital billing", true, { localHour: 21 }),
  },
  { id: "rent", label: "HARD legit: large but known payee", language: "en", expected: "LOW", hard: true,
    message: "Rental for October, RM1200 as usual. Thank you auntie.",
    tx: tx(1200, "Landlord (saved 3 years)", false, { usualMaxMYR: 1200 }),
  },
  { id: "renovation", label: "HARD legit: big new contractor", language: "en", expected: "MEDIUM", hard: true,
    message: "Auntie, deposit for the kitchen renovation is RM3000 as we discussed at your house last week.",
    tx: tx(3000, "Renovation contractor", true, { localHour: 15 }),
  },
  { id: "urgentreal", label: "HARD legit: urgent but genuine", language: "ms", expected: "MEDIUM", hard: true,
    message: "Mak, cepat sikit boleh? Kereta rosak kat bengkel, kena bayar RM450 hari ni baru boleh ambil.",
    tx: tx(450, "Bengkel Ali", true),
  },
  { id: "quietscam", label: "HARD scam: no urgency words", language: "en", expected: "MEDIUM", hard: true,
    message: "Good afternoon. Following our conversation, kindly proceed with the transfer to the account provided. Thank you for your cooperation.",
    tx: tx(4200, "Unknown account", true, { localHour: 23, transfersLastHour: 2 }),
  },
  { id: "nomessage", label: "HARD: no message, odd transfer", language: "en", expected: "MEDIUM", hard: true,
    message: "",
    tx: tx(4800, "Unknown account", true, { localHour: 2, transfersLastHour: 3 }),
  },
];

/** The subset shown as one-click presets in the demo UI. */
export const SCENARIOS: Case[] = [
  EVAL_CASES.find((c) => c.id === "macau")!,
  EVAL_CASES.find((c) => c.id === "newnumber")!,
  EVAL_CASES.find((c) => c.id === "invest")!,
  EVAL_CASES.find((c) => c.id === "otp")!,
  EVAL_CASES.find((c) => c.id === "hospital")!,
  EVAL_CASES.find((c) => c.id === "bill")!,
  EVAL_CASES.find((c) => c.id === "rent")!,
];
