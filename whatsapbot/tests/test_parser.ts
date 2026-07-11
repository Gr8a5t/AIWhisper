import { parseSignal } from '../src/parser.js';
import { validateSignal } from '../src/validator.js';
import dotenv from 'dotenv';
dotenv.config();

const mockMessages = [
  {
    name: "Standard Regex BUY Range",
    text: "XAUUSD BUY ZONE: 2320 - 2322\nSL: 2310\nTP1: 2335\nTP2: 2345\nTP3: 2360",
    shouldBeSignal: true
  },
  {
    name: "Standard Regex SELL Single Price",
    text: "GOLD SELL NOW @ 2350.50\nStop Loss 2360\nTP1 2340\nTP2 2330",
    shouldBeSignal: true
  },
  {
    name: "Narrative BUY (Gemini Fallback Target)",
    text: "Hey guys, let's take a Buy on Gold (XAUUSD) here. Current zone looks like 2345 to 2347. Target 1 is 2358, target 2 is 2370. I'll put my stop below the recent low at 2338.",
    shouldBeSignal: true
  },
  {
    name: "Sequential TPs (Regex List Fallback)",
    text: "GOLD SELL LIMIT 2380\nSL 2388\nTPs: 2370, 2362, 2350",
    shouldBeSignal: true
  },
  {
    name: "Ignore Update (TP Hit)",
    text: "GOLD TP1 Hit! Secure some profits ✅",
    shouldBeSignal: false
  },
  {
    name: "Ignore Other Pair",
    text: "EURUSD BUY at 1.0850, SL 1.0800, TP 1.0950",
    shouldBeSignal: false
  },
  {
    name: "Ignore Chit-Chat",
    text: "What do you think about gold today? Will it hit 2400?",
    shouldBeSignal: false
  }
];

async function runTests() {
  console.log("=== STARTING PARSER INTEGRATION TESTS ===\n");
  
  let passed = 0;
  let failed = 0;

  for (const mock of mockMessages) {
    console.log(`----------------------------------------`);
    console.log(`Test: ${mock.name}`);
    console.log(`Raw Message:\n"""\n${mock.text}\n"""`);
    
    try {
      const result = await parseSignal(mock.text);
      
      if (result.isSignal !== mock.shouldBeSignal) {
        console.error(`❌ FAILED: isSignal mismatch. Expected: ${mock.shouldBeSignal}, Got: ${result.isSignal}. Reason: ${result.reason || 'N/A'}`);
        failed++;
        continue;
      }

      if (result.isSignal && result.signal) {
        console.log(`✅ PARSED SUCCESSFULLY:`);
        console.log(`   Pair:      ${result.signal.pair}`);
        console.log(`   Direction: ${result.signal.direction}`);
        console.log(`   Entry:     ${result.signal.entryMin} - ${result.signal.entryMax}`);
        console.log(`   SL:        ${result.signal.sl}`);
        console.log(`   TP1:       ${result.signal.tp1}`);
        if (result.signal.tp2) console.log(`   TP2:       ${result.signal.tp2}`);
        if (result.signal.tp3) console.log(`   TP3:       ${result.signal.tp3}`);
        
        // Run validation check
        const validation = validateSignal(result.signal);
        console.log(`   Validation: ${validation.valid ? 'VALID' : 'INVALID'}`);
        if (!validation.valid) {
          console.log(`   Errors:    ${validation.errors.join(', ')}`);
        }
        console.log(`   R:R (TP1): ${validation.rrRatio?.toFixed(2)}`);
      } else {
        console.log(`✅ IGNORED CORRECTLY. Reason: ${result.reason}`);
      }
      
      passed++;
    } catch (err: any) {
      console.error(`❌ TEST ERROR: ${err.message}`);
      failed++;
    }
  }

  console.log(`\n========================================`);
  console.log(`Test Summary: Passed ${passed}/${mockMessages.length}, Failed ${failed}/${mockMessages.length}`);
  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error("Critical test runner crash:", err);
  process.exit(1);
});
