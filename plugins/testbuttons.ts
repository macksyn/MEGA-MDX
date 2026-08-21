/**
 * plugins/testbuttons.ts
 *
 * Isolated smoke test for gifted-btns. No economy/wallet code touched —
 * this exists purely to confirm buttons actually render as tappable UI
 * on real devices, not just that the call doesn't throw.
 *
 * Commands:
 *   .testbtn        -> simple quick-reply buttons
 *   .testbtn cta     -> cta_url / call button variant
 *   .testbtn list    -> single_select (list) variant
 *
 * ADJUST: import path, handler signature, and how you pull `sock`/`m`
 * to match your actual pluginLoader.ts contract. This assumes the common
 * (sock, m, args) shape seen across chatbot.ts / antilink.ts style plugins.
 */

// This project runs as ESM ("type": "module" in package.json), but
// gifted-btns is published as CommonJS ("type": "commonjs", main: "gifted.js").
// Top-level `require()` does not exist in ESM scope, so we bridge via
// Node's createRequire — this is the standard way to consume a CJS-only
// package from an ESM file without renaming anything to .cjs.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const {
  sendButtons,
  sendInteractiveMessage,
  validateSendButtonsPayload,
  validateSendInteractiveMessagePayload,
} = require('gifted-btns');
// Confirmed via `node -e "console.log(require('gifted-btns'))"`: version 1.0.2,
// CJS module. Confirmed via direct testing: the validate* functions do NOT
// throw — they return { valid: boolean, errors: string[], warnings: string[] }.
// Example: validateSendButtonsPayload({}) ->
//   { valid: false, errors: ["text is mandatory...", "buttons is mandatory..."], warnings: [] }

interface WASocket {
  sendMessage: (jid: string, content: any, options?: any) => Promise<any>;
  [key: string]: any;
}

export default {
  command: 'testbtn',
  description: 'Smoke test for gifted-btns rendering',

  // Confirmed against lib/commandHandler.ts: monitoredHandler itself is
  // called as (sock, message, ...args) from messageHandler.ts, then invokes
  // `handler(sock, message, ...args)`. Because monitoredHandler's own ...args
  // rest-collects whatever messageHandler passed (apparently a single args
  // array, not individually spread strings), spreading it again here hands
  // the plugin handler that one array as its third positional param — not
  // a spread of strings. So the real shape is a single array, not a rest.
  async handler(sock: WASocket, message: any, args: string[]) {
    const jid = message.key.remoteJid;
    const mode = args?.[0]?.toLowerCase();

    // Local helper so all three modes report validation failures the same
    // way, and so a bad payload never reaches sendButtons/sendInteractiveMessage.
    const assertValid = (result: { valid: boolean; errors: string[]; warnings: string[] }) => {
      if (result.warnings.length) {
        console.warn('[testbtn] payload warnings:', result.warnings);
      }
      if (!result.valid) {
        throw new Error(`Payload invalid: ${result.errors.join('; ')}`);
      }
    };

    try {
      if (mode === 'cta') {
        const payload = {
          text: 'CTA button test — do you see a tappable "Open Site" button below?',
          footer: 'gifted-btns smoke test',
          interactiveButtons: [
            {
              name: 'cta_url',
              buttonParamsJson: JSON.stringify({
                display_text: 'Open Site',
                url: 'https://github.com/macksyn/MEGA-MDX',
              }),
            },
            {
              name: 'quick_reply',
              buttonParamsJson: JSON.stringify({
                display_text: 'It works ✅',
                id: 'testbtn_cta_ok',
              }),
            },
          ],
        };
        assertValid(validateSendInteractiveMessagePayload(payload));
        await sendInteractiveMessage(sock, jid, payload);
      } else if (mode === 'list') {
        const payload = {
          text: 'List/single_select test — tap to open the menu.',
          footer: 'gifted-btns smoke test',
          interactiveButtons: [
            {
              name: 'single_select',
              buttonParamsJson: JSON.stringify({
                title: 'Choose one',
                sections: [
                  {
                    title: 'Test Options',
                    rows: [
                      { id: 'testbtn_list_a', title: 'Option A', description: 'First test row' },
                      { id: 'testbtn_list_b', title: 'Option B', description: 'Second test row' },
                    ],
                  },
                ],
              }),
            },
          ],
        };
        assertValid(validateSendInteractiveMessagePayload(payload));
        await sendInteractiveMessage(sock, jid, payload);
      } else {
        // Default: plain quick-reply buttons — this is the case that
        // matters most, since it's the one menuSession.ts was built to
        // replace if buttons ever start working reliably.
        const payload = {
          text: 'Quick reply test — tap any button below.',
          footer: 'gifted-btns smoke test',
          buttons: [
            { id: 'testbtn_balance', text: '💰 Balance' },
            { id: 'testbtn_bank', text: '🏦 Bank' },
            { id: 'testbtn_shop', text: '🛒 Shop' },
          ],
        };
        assertValid(validateSendButtonsPayload(payload));
        await sendButtons(sock, jid, payload);
      }

      // gifted-btns itself logs "Interactive send: { type, nodes, private }"
      // internally when it fires — that's expected noise from the package,
      // not a bug. Use it to confirm the binary-node injection path actually
      // ran (as opposed to silently falling through to a plain text send).
      console.log(`[testbtn] sent (mode=${mode || 'default'}) to ${jid}`);
    } catch (err) {
      // Explicitly do NOT fall back to menuSession here — for this test
      // you want to know immediately if gifted-btns itself is broken,
      // not have it silently masked by a working fallback.
      const message = (err as Error).message || '';
      const isValidationError = message.startsWith('Payload invalid:');
      console.error(
        `[testbtn] ${isValidationError ? 'payload validation' : 'send'} failed:`,
        err
      );
      await sock.sendMessage(jid, {
        text: isValidationError
          ? `❌ Payload was malformed before it even reached WhatsApp — this is a bug in the test payload, not gifted-btns itself.\n\n${message}`
          : `❌ gifted-btns threw sending — check console.\n\n${message}`,
      });
    }
  },

  // Listen for the button taps so you can confirm the round-trip, not
  // just that the message sent. This is NOT wired into your loader yet —
  // there's no evidence from commandHandler.ts that onButtonResponse is a
  // recognized lifecycle hook. Confirm how your loader dispatches
  // interactiveResponseMessage / buttonsResponseMessage events (likely in
  // messageHandler.ts, based on the stack trace) before relying on this.
  //
  // Signature kept positional to match the (sock, message, ...args) pattern
  // confirmed above, rather than the earlier guessed object-destructure shape.
  async onButtonResponse(sock: WASocket, message: any) {
    const selectedId =
      message.message?.buttonsResponseMessage?.selectedButtonId ||
      message.message?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;

    if (selectedId) {
      console.log('[testbtn] tap received:', selectedId);
      await sock.sendMessage(message.key.remoteJid, {
        text: `✅ Round-trip confirmed. You tapped: ${selectedId}`,
      });
    }
  },
};