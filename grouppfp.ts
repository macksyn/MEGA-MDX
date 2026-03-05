export default {
    command: 'grouppfp',
    aliases: ['setgrouppfp', 'groupicon', 'setgroupicon', 'removegrouppfp'],
    category: 'group',
    description: 'Set or remove group profile picture',
    usage: '.grouppfp — reply to an image\n.removegrouppfp — remove group picture',
    groupOnly: true,
    adminOnly: true,

    async handler(sock: any, message: any, args: any[], context: any = {}) {
        const chatId = context.chatId || message.key.remoteJid;
        const channelInfo = context.channelInfo || {};
        const rawText = (context.rawText || '').toLowerCase();
        const isBotAdmin = context.isBotAdmin || false;

        if (!isBotAdmin) {
            return await sock.sendMessage(chatId, {
                text: `❌ Bot needs to be an admin to change group picture.`,
                ...channelInfo
            }, { quoted: message });
        }

        // Remove profile picture
        if (rawText.startsWith('.removegrouppfp')) {
            try {
                await sock.removeProfilePicture(chatId);
                return await sock.sendMessage(chatId, {
                    text: `✅ *Group picture removed!*`,
                    ...channelInfo
                }, { quoted: message });
            } catch (e: any) {
                return await sock.sendMessage(chatId, {
                    text: `❌ Failed to remove picture: ${e.message}`,
                    ...channelInfo
                }, { quoted: message });
            }
        }

        // Get image from quoted message or current message
        const quoted = message.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        const imgMsg =
            message.message?.imageMessage ||
            quoted?.imageMessage ||
            message.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage;

        if (!imgMsg) {
            return await sock.sendMessage(chatId, {
                text: `❌ Please reply to an image.\n\n*Usage:* Reply to any image with \`.grouppfp\``,
                ...channelInfo
            }, { quoted: message });
        }

        try {
            const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
            const buffer = await downloadMediaMessage(
                {
                    key: message.message?.extendedTextMessage?.contextInfo?.stanzaId
                        ? { ...message.key, id: message.message.extendedTextMessage.contextInfo.stanzaId }
                        : message.key,
                    message: quoted || message.message
                },
                'buffer',
                {},
                { logger: console as any, reuploadRequest: sock.updateMediaMessage }
            );

            await sock.updateProfilePicture(chatId, buffer as Buffer);
            return await sock.sendMessage(chatId, {
                text: `✅ *Group picture updated!*`,
                ...channelInfo
            }, { quoted: message });
        } catch (e: any) {
            console.error('[GROUPPFP] Error:', e.message);
            return await sock.sendMessage(chatId, {
                text: `❌ Failed to update picture: ${e.message}`,
                ...channelInfo
            }, { quoted: message });
        }
    }
};
