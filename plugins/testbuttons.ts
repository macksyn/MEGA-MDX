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

import { sendButtons, sendInteractiveMessage } from 'gifted-btns';
// If gifted-btns exports under different names, check:
//   node_modules/gifted-btns/README.md
//   node_modules/gifted-btns/package.json -> "main" / "exports" field
// and adjust the import above. Some forks in this family (zqbaileys_helper,
// @ryuu-reinzz/button-helper) expose the same two function names, but
// gifted-btns may differ slightly — verify before assuming this compiles.

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

    try {
      if (mode === 'cta') {
        await sendInteractiveMessage(sock, jid, {
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
        });
      } else if (mode === 'list') {
        await sendInteractiveMessage(sock, jid, {
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
        });
      } else {
        // Default: plain quick-reply buttons — this is the case that
        // matters most, since it's the one menuSession.ts was built to
        // replace if buttons ever start working reliably.
        await sendButtons(sock, jid, {
          text: 'Quick reply test — tap any button below.',
          footer: 'gifted-btns smoke test',
          buttons: [
            { id: 'testbtn_balance', text: '💰 Balance' },
            { id: 'testbtn_bank', text: '🏦 Bank' },
            { id: 'testbtn_shop', text: '🛒 Shop' },
          ],
        });
      }

      console.log(`[testbtn] sent (mode=${mode || 'default'}) to ${jid}`);
    } catch (err) {
      // Explicitly do NOT fall back to menuSession here — for this test
      // you want to know immediately if gifted-btns itself is broken,
      // not have it silently masked by a working fallback.
      console.error('[testbtn] gifted-btns call failed:', err);
      await sock.sendMessage(jid, {
        text: `❌ gifted-btns threw an error — check console.\n\n${(err as Error).message}`,
      });
    }
  },

  // Listen for the button taps so you can confirm the round-trip, not
  // just that the message sent. Wire this into whatever event your
  // pluginLoader uses for interactiveResponseMessage / buttonsResponseMessage.
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