const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys')
const qrcode = require('qrcode-terminal')

// Função principal
async function startCleiton() {
    const { state, saveCreds } = await useMultiFileAuthState('cleiton_auth')
    const sock = makeWASocket({
        auth: state
    })

    // Evento: conexão
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update

	if (qr) {
    console.log('📲 Escaneie o QR code:')
    qrcode.generate(qr, { small: true })
	}


        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode
            if (reason !== DisconnectReason.loggedOut) {
                console.log("🔄 Cleiton caiu, reconectando...")
                startCleiton()
            } else {
                console.log("❌ Cleiton foi deslogado.")
            }
        } else if (connection === 'open') {
            console.log('✅ Cleiton tá online no WhatsApp!')
        }
    })

    // Evento: salvar sessão
    sock.ev.on('creds.update', saveCreds)

    // Evento: mensagens recebidas
    sock.ev.on('messages.upsert', async (msg) => {
        const m = msg.messages[0]
        if (!m.message || m.key.fromMe) return

        const from = m.key.remoteJid
        const text = m.message.conversation || m.message.extendedTextMessage?.text || ""

        console.log(`📩 Mensagem de ${from}: ${text}`)

        // Comandos básicos
        if (text.toLowerCase() === '!ping') {
            await sock.sendMessage(from, { text: "🏓 Pong! Aqui é o Cleiton." })
        }

        if (text.toLowerCase() === '!menu') {
            await sock.sendMessage(from, { text: "📋 Menu do Cleiton:\n\n👉 !ping\n👉 !menu\n👉 !help" })
        }
    })

    // Evento: participante entrou/saiu do grupo
    sock.ev.on('group-participants.update', async (update) => {
        try {
            const metadata = await sock.groupMetadata(update.id)
            for (const participant of update.participants) {
                if (update.action === 'add') {
                    await sock.sendMessage(update.id, { text: `👋 Bem-vindo(a), @${participant.split('@')[0]} ao grupo *${metadata.subject}*!`, mentions: [participant] })
                } else if (update.action === 'remove') {
                    // não faz nada ao sair
                } else if (update.action === 'invite') {
                    await sock.sendMessage(update.id, { text: `🙌 Bem-vindo(a) de volta, @${participant.split('@')[0]}!`, mentions: [participant] })
                }
            }
        } catch (err) {
            console.error(err)
        }
    })
}

startCleiton()
