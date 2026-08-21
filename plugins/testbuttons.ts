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

// gifted-btns' README only demonstrates CommonJS `require(...)`. If your
// tsconfig doesn't have "esModuleInterop": true, a named `import` may not
// resolve the two functions correctly. This require-style pattern works
// regardless of your TS module config — swap to a named `import` only
// after confirming node_modules/gifted-btns/package.json exposes ESM exports.
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

interface PluginContext {
  sock: any; // WASocket from @whiskeysockets/baileys
  m: any;    // the incoming message object from your loader
  args: string[];
}

export default {
  command: 'testbtn',
  description: 'Smoke test for gifted-btns rendering',

  async handler({ sock, m, args }: PluginContext) {
    const jid = m.key.remoteJid;
    const mode = args[0]?.toLowerCase();

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
          text: 'Quick reply test — Tamara what do you want?',
          footer: 'Btns smoke test',
          buttons: [
            { id: 'testbtn_balance', text: '💰 Money' },
            { id: 'testbtn_bank', text: '🏦 House' },
            { id: 'testbtn_shop', text: '🛒 Shopping' },
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
  // just that the message sent. Wire this into whatever event your
  // pluginLoader uses for interactiveResponseMessage / buttonsResponseMessage.
  //
  // NOTE: gifted-btns' README doesn't document incoming tap parsing at all —
  // it only covers outbound sends. The shape below (buttonsResponseMessage /
  // nativeFlowResponseMessage.paramsJson) is standard Baileys message
  // decoding, unrelated to this package. Treat it as a reasonable starting
  // guess to verify against your actual Baileys version, not a documented
  // contract from gifted-btns.
  async onButtonResponse({ sock, m }: { sock: any; m: any }) {
    const selectedId =
      m.message?.buttonsResponseMessage?.selectedButtonId ||
      m.message?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;

    if (selectedId) {
      console.log('[testbtn] tap received:', selectedId);
      await sock.sendMessage(m.key.remoteJid, {
        text: `✅ Round-trip confirmed. You tapped: ${selectedId}`,
      });
    }
  },
};