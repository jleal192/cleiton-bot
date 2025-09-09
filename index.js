const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys')
const qrcode = require('qrcode-terminal')
const fetch = require('node-fetch')
const ytdl = require('ytdl-core')
const ytSearch = require('yt-search')
const fs = require('fs')

// Função principal
async function startDobby() {
    const { state, saveCreds } = await useMultiFileAuthState('dobby_auth')
    const sock = makeWASocket({ auth: state })

    // Evento: conexão
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update
        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode
            if (reason !== DisconnectReason.loggedOut) {
                console.log("🔄 Dobby caiu, reconectando...")
                startDobby()
            } else {
                console.log("❌ Dobby foi deslogado.")
            }
        } else if (connection === 'open') {
            console.log('✅ Dobby tá online no WhatsApp!')
        }
    })

    sock.ev.on('creds.update', saveCreds)

    // Função para pegar frase motivacional do ZenQuotes
    async function pegarFraseZen() {
        try {
            const res = await fetch('https://zenquotes.io/api/random', {
                headers: { 'User-Agent': 'Mozilla/5.0' }
            })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const data = await res.json()
            if (!data || !data[0] || !data[0].q || !data[0].a)
                throw new Error('Resposta inválida da API')
            return `${data[0].q} — ${data[0].a}`
        } catch (err) {
            console.error('Erro ao buscar frase Zen:', err)
            return "💡 Mantenha-se motivado hoje!"
        }
    }

    // Função para baixar música do YouTube
    async function baixarMusica(url, filename) {
        return new Promise((resolve, reject) => {
            const stream = ytdl(url, { filter: 'audioonly' })
            stream.pipe(fs.createWriteStream(filename))
            stream.on('end', () => resolve())
            stream.on('error', (err) => reject(err))
        })
    }

    // Evento: mensagens recebidas
    sock.ev.on('messages.upsert', async (msg) => {
        const m = msg.messages[0]
        if (!m.message || m.key.fromMe) return
        const from = m.key.remoteJid
        const text = m.message.conversation || m.message.extendedTextMessage?.text || ""
        const cmd = text.toLowerCase()

        // Comandos simples
        if (cmd === '.ping') await sock.sendMessage(from, { text: "🏓 Pong! Aqui é o Dobby." })
        if (cmd === '.menu') await sock.sendMessage(from, { text: "📋 Menu do Dobby:\n\n👉 .ping\n👉 .menu\n👉 .help\n👉 .tocar\n👉 .figura\n👉 .bomdia/.boatarde/.boanoite/.boamadrugada\n👉 .evento\n👉 .todos" })
        if (cmd === '.help') await sock.sendMessage(from, { 
            text: "🆘 Ajuda do Dobby:\n\n" +
                  "👉 *.ping* – Testa se tô online (respondo Pong 🏓)\n" +
                  "👉 *.menu* – Mostra o menu rápido\n" +
                  "👉 *.tocar [nome ou link]* – Baixo e mando a música em áudio 🎶\n" +
                  "👉 *.figura* – Transformo uma foto em figurinha (manda junto a imagem)\n" +
                  "👉 *.bomdia / .boatarde / .boanoite / .boamadrugada* – Mando uma frase motivacional ✨\n" +
                  "👉 *.evento* – Lista os eventos da semana 📅\n" +
                  "👉 *.todos [mensagem]* – Marca todos do grupo 📢"
        })

        // Frases motivacionais
        if ([".bomdia", ".boatarde", ".boanoite", ".boamadrugada"].includes(cmd)) {
            const frase = await pegarFraseZen()
            await sock.sendMessage(from, { text: `@${m.key.participant?.split('@')[0]} ${frase}`, mentions: [m.key.participant] })
        }

        // Música do YouTube
        if (cmd.startsWith('.tocar ')) {
            const query = text.substring(7).trim()
            await sock.sendMessage(from, { text: `🎵 Buscando sua música: ${query}` })
            try {
                const result = await ytSearch(query)
                const video = result.videos[0]
                if (!video) return await sock.sendMessage(from, { text: "❌ Música não encontrada." })

                const url = video.url
                const filename = `musica.mp3`
                await baixarMusica(url, filename)
                await sock.sendMessage(from, { audio: fs.readFileSync(filename), mimetype: 'audio/mpeg' })
                fs.unlinkSync(filename)
            } catch (err) {
                console.error(err)
                await sock.sendMessage(from, { text: "❌ Ocorreu um erro ao tocar a música." })
            }
        }

        // Figura (sticker)
        if (cmd === '.figura') {
            let buffer
            try {
                if (m.message.imageMessage) {
                    buffer = await sock.downloadMediaMessage(m)
                } else if (m.message.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage) {
                    const quoted = {
                        key: {
                            remoteJid: from,
                            id: m.message.extendedTextMessage.contextInfo.stanzaId,
                            fromMe: false
                        },
                        message: m.message.extendedTextMessage.contextInfo.quotedMessage
                    }
                    buffer = await sock.downloadMediaMessage(quoted)
                }
                if (buffer) {
                    await sock.sendMessage(from, { sticker: buffer })
                } else {
                    await sock.sendMessage(from, { text: "❌ Nenhuma imagem encontrada para figurinha." })
                }
            } catch (err) {
                console.error('Erro ao criar figurinha:', err)
                await sock.sendMessage(from, { text: "❌ Ocorreu um erro ao criar a figurinha." })
            }
        }

        // Comando .evento
        if (cmd === '.evento') {
            const eventos = [
                "Segunda: Começa tudo de novo!",
                "Quinta: Quintas Intenções",
                "Sexta: Happy Hour e Divulga seu trampo aí",
                "Sábado: Encontrão - Parque de Madureira"
            ]
            await sock.sendMessage(from, { text: `📅 Eventos da semana:\n\n${eventos.join("\n")}` })
        }

        // Comando .todos
        if (cmd.startsWith('.todos')) {
            try {
                const metadata = await sock.groupMetadata(from)
                const participants = metadata.participants.map(p => p.id)
                const mensagem = text.replace('.todos', '').trim() || "📢 Chamando todo mundo!"
                await sock.sendMessage(from, { text: mensagem, mentions: participants })
            } catch (err) {
                console.error("Erro no .todos:", err)
            }
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
                    // não faz nada
                } else if (update.action === 'invite') {
                    await sock.sendMessage(update.id, { text: `🙌 Bem-vindo(a) de volta, @${participant.split('@')[0]}!`, mentions: [participant] })
                }
            }
        } catch (err) {
            console.error(err)
        }
    })
}

startDobby()
