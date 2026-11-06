/**
 * plugins/testbuttons.ts
 *
 * Isolated smoke test for gifted-btns. No economy/wallet code touched —
 * this exists purely to confirm buttons actually render as tappable UI
 * on real devices, not just that the call doesn't throw.
 *
 * Commands:
 *   .testbtn         -> simple quick-reply buttons (3)
 *   .testbtn <1-15>  -> N quick-reply buttons (device rendering / ceiling test)
 *   .testbtn cta     -> cta_url / call button variant
 *   .testbtn list    -> single_select (list) variant
 *
 * iPhone test plan: run `.testbtn 3`, `.testbtn 5`, `.testbtn 10` from an
 * iPhone and from an Android phone, and note for each:
 *   1. does the message appear at all?
 *   2. how many buttons render?
 *   3. does the tap echo back "Round-trip confirmed"? (the raw tap payload
 *      is also printed to the console — send it over if a tap doesn't echo)
 *   4. is the device guess in the message body correct?
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

const MAX_TEST_BUTTONS = 15; // raised from 10 to probe the iOS ceiling (.testbtn 11 / 12 / 15)

// Sent test messages, keyed by message id -> short label, so the tap
// listener only reacts to replies to *our* test messages.
const sentTests = new Map<string, string>();
const registeredSocks = new WeakSet<any>();

/**
 * Best-effort device guess from a WhatsApp message id (same pattern commonly
 * used in Baileys bots). A heuristic, not a guarantee — verify it against a
 * known iPhone and a known Android phone using the output of this test.
 */
function guessDevice(id: string = ''): string {
  if (/^3A.{18}$/.test(id)) return 'ios';
  if (/^3E.{20}$/.test(id)) return 'web';
  if (/^(.{21}|.{32})$/.test(id)) return 'android';
  return 'unknown';
}

/** Pulls the tapped id out of whichever response shape arrived. */
function extractTapId(m: any): string | null {
  if (m.templateButtonReplyMessage?.selectedId) return m.templateButtonReplyMessage.selectedId;
  if (m.buttonsResponseMessage?.selectedButtonId) return m.buttonsResponseMessage.selectedButtonId;
  if (m.listResponseMessage?.singleSelectReply?.selectedRowId) {
    return m.listResponseMessage.singleSelectReply.selectedRowId;
  }
  const params = m.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;
  if (params) {
    try {
      const parsed = JSON.parse(params);
      if (parsed?.id) return parsed.id;
    } catch {
      /* fall through */
    }
    return params; // unknown JSON shape — still show it rather than hide it
  }
  return null;
}

/**
 * Registers one tap listener per sock. onButtonResponse isn't a recognized
 * loader hook (see header notes in the previous version), so this listens on
 * the socket directly instead.
 */
function registerTapListener(sock: any) {
  if (registeredSocks.has(sock)) return;
  registeredSocks.add(sock);

  sock.ev.on('messages.upsert', async (upsert: any) => {
    try {
      const msg = upsert.messages?.[0];
      if (!msg || msg.key?.fromMe || !msg.message) return;

      const m = msg.message;
      const reply =
        m.templateButtonReplyMessage ||
        m.buttonsResponseMessage ||
        m.listResponseMessage ||
        m.interactiveResponseMessage;
      const quotedId = reply?.contextInfo?.stanzaId;
      if (!quotedId || !sentTests.has(quotedId)) return;

      // Raw payload: an iOS tap may arrive in a different shape than Android's.
      console.log('[testbtn] tap payload:', JSON.stringify(m, null, 2));

      const tapped = extractTapId(m) ?? '(unrecognized shape — check console)';
      await sock.sendMessage(
        msg.key.remoteJid,
        {
          text:
            `✅ Round-trip confirmed. You tapped: ${tapped}\n` +
            `Test: ${sentTests.get(quotedId)} · tap device guess: ${guessDevice(msg.key.id)}`,
        },
        { quoted: msg }
      );
    } catch (err) {
      console.error('[testbtn] tap listener error:', err);
    }
  });
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
    const device = guessDevice(message.key.id);

    registerTapListener(sock);

    // Local helper so all modes report validation failures the same
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
      let sent: any;
      let label = mode || 'default';

      if (mode && /^\d+$/.test(mode)) {
        // Button-count test: N quick_reply buttons, to find where iOS (or
        // Android) stops rendering them.
        const count = Math.min(Math.max(parseInt(mode, 10), 1), MAX_TEST_BUTTONS);
        label = `${count} buttons`;

        const payload = {
          text:
            `*Button count test*: ${count} quick_reply button${count === 1 ? '' : 's'}\n` +
            `Your device guess: ${device}\n` +
            `Tap any button — note how many you can see.`,
          footer: 'gifted-btns smoke test',
          buttons: Array.from({ length: count }, (_, i) => ({
            id: `testbtn_n${i + 1}`,
            text: `Option ${i + 1}`,
          })),
        };

        // Above 3 buttons the validator may complain. This test exists to
        // find out what devices actually render, so log its verdict but
        // still send rather than blocking.
        const verdict = validateSendButtonsPayload(payload);
        if (!verdict.valid || verdict.warnings.length) {
          console.warn(`[testbtn] validator verdict for ${count} buttons:`, verdict);
        }
        sent = await sendButtons(sock, jid, payload);
      } else if (mode === 'cta') {
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
        sent = await sendInteractiveMessage(sock, jid, payload);
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
        sent = await sendInteractiveMessage(sock, jid, payload);
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
        sent = await sendButtons(sock, jid, payload);
      }

      if (sent?.key?.id) sentTests.set(sent.key.id, label);

      // gifted-btns itself logs "Interactive send: { type, nodes, private }"
      // internally when it fires — that's expected noise from the package,
      // not a bug. Use it to confirm the binary-node injection path actually
      // ran (as opposed to silently falling through to a plain text send).
      console.log(
        `[testbtn] sent (mode=${label}) to ${jid} · invoker msg id ${message.key.id} -> device guess: ${device}`
      );
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
};