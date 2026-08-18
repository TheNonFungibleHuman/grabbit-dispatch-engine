import readline from "node:readline";
import { processIncomingUserMessage } from "../lib/agent/index.ts";
import { handleRiderReply } from "../lib/orders/pre-booking.ts";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const CUSTOMER_PHONE = "+99900000035";
const RIDER_PHONE = process.env.TEST_RIDER_PHONE || "+99900000027";

console.log("===============================================================");
console.log(" 🛵 GRABBIT EXPRESS LIVE DISPATCH & PRE-BOOKING SIMULATOR");
console.log("===============================================================");
console.log(`• Customer Test Phone: ${CUSTOMER_PHONE}`);
console.log(`• Rider Physical Phone: ${RIDER_PHONE} (Receives real WhatsApps!)`);
console.log("---------------------------------------------------------------\n");
console.log("Commands you can try:");
console.log('1. Type: "I want to book a ride from ALCHE to Mahogany tomorrow at 12:00 PM"');
console.log('2. Type: "rider: YES" (or reply YES from the rider phone)');
console.log('3. Type: "exit" to quit.\n');

function promptUser() {
  rl.question("👤 You (Customer) > ", async (input) => {
    const text = input.trim();
    if (!text) {
      promptUser();
      return;
    }

    if (text.toLowerCase() === "exit") {
      rl.close();
      process.exit(0);
    }

    // Check if simulating rider reply
    if (text.toLowerCase().startsWith("rider:")) {
      const riderReplyText = text.slice(6).trim();
      console.log(`\n🛵 Processing Rider Reply (${RIDER_PHONE}): "${riderReplyText}"...`);
      const result = await handleRiderReply({
        senderPhone: RIDER_PHONE,
        text: riderReplyText,
      });
      console.log(`• Handled: ${result.handled}`);
      if (result.responseMessage) {
        console.log(`• Response to Rider: "${result.responseMessage}"\n`);
      }
      promptUser();
      return;
    }

    // Process customer message via DeepSeek
    console.log("\n🤖 Grabbit AI thinking & checking schedule...");
    try {
      await processIncomingUserMessage({
        messageId: `sim_${Date.now()}`,
        sender: CUSTOMER_PHONE,
        text,
        pushName: "Test Customer",
      });
      console.log("\n✅ AI Response sent! (Check your rider phone for confirmation text if trip was logged!)\n");
    } catch (err) {
      console.error("❌ Error processing message:", err);
    }

    promptUser();
  });
}

promptUser();
