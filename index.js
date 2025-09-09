const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys')
const qrcode = require('qrcode-terminal')
const fetch = require('node-fetch')
const ytdl = require('ytdl-core')
const fs = require('fs')

// Função principal
async function startCleiton() {
    const { state, saveCreds } = await useMultiFileAuthState('cleiton_auth')
    const sock = makeWASocket({ auth: state })

    // Evento: conexão
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update
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

    sock.ev.on('creds.update', saveCreds)

    // Função para pegar frase motivacional
    async function pegarFraseZen() {
        try {
            const res = await fetch('https://zenquotes.io/api/random')
            const data = await res.json()
            return `${data[0].q} — ${data[0].a}`
        } catch (err) {
            console.error('Erro ao buscar frase:', err)
            return "💡 Mantenha-se motivado hoje!"
        }
    }

    // Função para baixar música do YouTube
    async function baixarMusica(query, filename) {
        return new Promise(async (resolve, reject) => {
            try {
                const search = await ytdl.getInfo(query).catch(() => null)
                let url = query
                if (!ytdl.validateURL(query) && search?.videoDetails?.video_url) {
                    url = search.videoDetails.video_url
                }

                const stream = ytdl(url, { filter: 'audioonly' })
                stream.pipe(fs.createWriteStream(filename))
                stream.on('end', () => resolve())
                stream.on('error', (err) => reject(err))
            } catch (err) {
                reject(err)
            }
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
        if (cmd === '.ping') await sock.sendMessage(from, { text: "🏓 Pong! Aqui é o Cleiton." })

        if (cmd === '.menu') await sock.sendMessage(from, { 
            text: "📋 Menu do Cleiton:\n\n👉 .ping\n👉 .menu\n👉 .help\n👉 .tocar\n👉 .figura\n👉 .bomdia/.boatarde/.boanoite/.boamadrugada\n👉 .evento\n👉 .todos" 
        })

        if (cmd === '.help') {
            await sock.sendMessage(from, { 
                text: "🆘 Ajuda do Cleiton:\n\n" +
                      "👉 *.ping* – Testa se tô online (respondo Pong 🏓)\n" +
                      "👉 *.menu* – Mostra o menu rápido\n" +
                      "👉 *.tocar [nome ou link]* – Baixo e mando a música em áudio 🎶\n" +
                      "👉 *.figura* – Transformo uma foto em figurinha (manda junto a imagem)\n" +
                      "👉 *.bomdia / .boatarde / .boanoite / .boamadrugada* – Mando uma frase motivacional ✨\n" +
                      "👉 *.evento* – Lista os eventos da semana 📅\n" +
                      "👉 *.todos [mensagem]* – Marca todos do grupo 📢"
            })
        }

        // Frases motivacionais
        if ([".bomdia", ".boatarde", ".boanoite", ".boamadrugada"].includes(cmd)) {
            const frase = await pegarFraseZen()
            await sock.sendMessage(from, { text: `@${m.key.participant?.split('@')[0]} ${frase}`, mentions: [m.key.participant] })
        }

        // Música do YouTube
        if (cmd.startsWith('.tocar ')) {
            const query = text.substring(7).trim()
            const fileName = `musica.mp3`
            await sock.sendMessage(from, { text: `🎵 Baixando sua música: ${query}` })
            try {
                await baixarMusica(query, fileName)
                await sock.sendMessage(from, { audio: fs.readFileSync(fileName), mimetype: 'audio/mpeg' })
                fs.unlinkSync(fileName)
            } catch {
                await sock.sendMessage(from, { text: "❌ Não consegui baixar a música." })
            }
        }

        // Figura (sticker)
        if (cmd === '.figura' && m.message.imageMessage) {
            const buffer = await sock.downloadMediaMessage(m)
            await sock.sendMessage(from, { sticker: buffer })
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

                await sock.sendMessage(from, { 
                    text: mensagem, 
                    mentions: participants 
                })
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
