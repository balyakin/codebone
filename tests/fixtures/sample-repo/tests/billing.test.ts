import { expect, it } from "vitest";
import { createInvoice, finalizeInvoice } from "../src/billing.js";

it("creates invoice", () => {
  const invoice = createInvoice("u1", 100);
  expect(invoice.status).toBe("draft");
  expect(finalizeInvoice(invoice).status).toBe("final");
});
