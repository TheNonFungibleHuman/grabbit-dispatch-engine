import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanCustomerGreetingName, isBareGreeting, isShortAcknowledgement } from "./format.ts";
import { buildGrabbitSystemInstruction } from "./prompt.ts";
import { recordPendingEscalation, getOpenCustomerEscalation } from "../ops/store.ts";
import { appendTranscriptEntry, loadTranscript, markTranscriptBookingQuiet } from "./transcript.ts";

describe("Felicia & Jacenta Incident Audit (Saturday, Sept 12, 2026) Regressions", () => {
  describe("cleanCustomerGreetingName", () => {
    it("rejects social handles and usernames containing digits (Jacenta jwangirl07 incident)", () => {
      assert.equal(cleanCustomerGreetingName("jwangirl07"), undefined);
      assert.equal(cleanCustomerGreetingName("user_123"), undefined);
      assert.equal(cleanCustomerGreetingName("alex99"), undefined);
      assert.equal(cleanCustomerGreetingName("999000000010"), undefined);
    });

    it("rejects handles with special symbols like underscores, slashes, or @", () => {
      assert.equal(cleanCustomerGreetingName("rider_01"), undefined);
      assert.equal(cleanCustomerGreetingName("@john"), undefined);
      assert.equal(cleanCustomerGreetingName("a/b"), undefined);
    });

    it("rejects single character or overly short names", () => {
      assert.equal(cleanCustomerGreetingName("M"), undefined);
      assert.equal(cleanCustomerGreetingName(""), undefined);
      assert.equal(cleanCustomerGreetingName("   "), undefined);
    });

    it("sanitizes emoji-decorated names properly", () => {
      assert.equal(cleanCustomerGreetingName("🌸 Sadia 🌸"), "Sadia");
      assert.equal(cleanCustomerGreetingName("Peace 🫶🏻"), "Peace");
      assert.equal(cleanCustomerGreetingName("Ambassador😎"), "Ambassador");
    });

    it("strips common prefix titles and extracts first name", () => {
      assert.equal(cleanCustomerGreetingName("Emp.Customer D"), "Customer D");
      assert.equal(cleanCustomerGreetingName("Dr. Francois"), "Francois");
      assert.equal(cleanCustomerGreetingName("Cyuzuzo Juliette"), "Cyuzuzo");
    });

    it("formats title-cased names from lowercase or uppercase inputs", () => {
      assert.equal(cleanCustomerGreetingName("felicia"), "Felicia");
      assert.equal(cleanCustomerGreetingName("FELICIA"), "Felicia");
      assert.equal(cleanCustomerGreetingName("Customer A"), "Customer A");
    });
  });

  describe("Short-acknowledgement checks and suppression", () => {
    it("identifies short acknowledgements properly", () => {
      assert.equal(isShortAcknowledgement("Ok"), true);
      assert.equal(isShortAcknowledgement("ok thanks"), true);
      assert.equal(isShortAcknowledgement("Thank you so much"), true);
      assert.equal(isShortAcknowledgement("noted"), true);
      assert.equal(isShortAcknowledgement("Drop off is at SSRN hospital"), false);
      assert.equal(isShortAcknowledgement("Can I book tomorrow Trip to grandbaie bus stop at 8.30"), false);
    });

    it("does not treat customer 'Ok' as a closing dismissal if an escalation is active (Felicia incident)", async () => {
      const testPhone = "+99900000075";
      await recordPendingEscalation({
        customerPhone: testPhone,
        customerName: "Felicia Test",
        reason: "SSRN destination clarification",
      });

      const openEsc = await getOpenCustomerEscalation(testPhone);
      assert.ok(openEsc, "escalation must be active");

      // Verify that the escalation prevents auto-dismissal
      const transcript = await loadTranscript(testPhone);
      await markTranscriptBookingQuiet(testPhone, 60);

      await appendTranscriptEntry(testPhone, {
        role: "agent",
        text: "Got your details! I've escalated this directly to our dispatch operations team so we can confirm your request right away.",
      });

      const agentEntries = (await loadTranscript(testPhone)).entries.filter((e) => e.role === "agent");
      const lastAgentText = (agentEntries[agentEntries.length - 1]?.text || "").toLowerCase();
      const isAwaitingResolution = Boolean(
        openEsc ||
        lastAgentText.includes("escalated") ||
        lastAgentText.includes("reviewing your request")
      );

      assert.equal(isAwaitingResolution, true, "customer session must be recognized as awaiting resolution");
    });
  });

  describe("System prompt invariants", () => {
    it("contains strict route orientation invariant to prevent route reversal", async () => {
      const prompt = await buildGrabbitSystemInstruction();
      assert.match(prompt, /STRICT ROUTE ORIENTATION INVARIANT/i);
      assert.match(prompt, /Pickup is strictly where the passenger boards/i);
      assert.match(prompt, /NEVER reverse or transpose them/i);
    });

    it("explicitly forbids escalations on address corrections and clarifies intake updates", async () => {
      const prompt = await buildGrabbitSystemInstruction();
      assert.match(prompt, /Address corrections or destination clarifications/i);
      assert.match(prompt, /DO NOT call escalate_to_admin/i);
      assert.match(prompt, /standard intake clarification/i);
    });
  });
});
