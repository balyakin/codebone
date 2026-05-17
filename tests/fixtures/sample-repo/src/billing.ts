export function createInvoice(userId: string, amount: number) {
  return { userId, amount, status: "draft" as const };
}

export function finalizeInvoice(invoice: { status: string }) {
  return { ...invoice, status: "final" as const };
}
