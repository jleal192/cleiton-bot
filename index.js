const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const fetch = require('node-fetch');
const ytdl = require('ytdl-core');
const ytSearch = require('yt-search');
const sharp = require('sharp');

async function startDobby() {
    const { state, saveCreds } = await useMultiFileAuthState('dobby_auth');
    const sock = makeWASocket({ auth: state });

    // Conexão
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            if (reason !== DisconnectReason.loggedOut) {
                console.log("🔄 Dobby caiu, reconectando...");
                startDobby();
            } else {
                console.log("❌ Dobby foi deslogado.");
            }
        } else if (connection === 'open') {
            console.log('✅ Dobby tá online no WhatsApp!');
        }
    });
    sock.ev.on('creds.update', saveCreds);

    // Função para frase motivacional
    async function pegarFraseZen() {
        try {
            const res = await fetch('https://zenquotes.io/api/random', { headers: { 'User-Agent': 'Mozilla/5.0' } });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (!data || !data[0] || !data[0].q || !data[0].a) throw new Error('Resposta inválida da API');
            return `${data[0].q} — ${data[0].a}`;
        } catch {
            return "💡 Mantenha-se motivado hoje!";
        }
    }

    // Mensagens recebidas
    sock.ev.on('messages.upsert', async (msg) => {
        const m = msg.messages[0];
        if (!m.message || m.key.fromMe) return;
        const from = m.key.remoteJid;
        const text = m.message.conversation || m.message.extendedTextMessage?.text || "";
        const cmd = text.toLowerCase();

        // Comandos simples
        if (cmd === '.ping') await sock.sendMessage(from, { text: "🏓 Pong! Aqui é o Dobby." });
        if (cmd === '.menu') await sock.sendMessage(from, { text: "📋 Menu do Dobby:\n\n👉 .ping\n👉 .menu\n👉 .help\n👉 .tocar\n👉 .figura\n👉 .bomdia/.boatarde/.boanoite/.boamadrugada\n👉 .evento\n👉 .todos" });
        if (cmd === '.help') await sock.sendMessage(from, { 
            text: "🆘 Ajuda do Dobby:\n\n" +
                  "👉 *.ping* – Testa se tô online (respondo Pong 🏓)\n" +
                  "👉 *.menu* – Mostra o menu rápido\n" +
                  "👉 *.tocar [nome ou link]* – Baixo e mando a música em áudio 🎶\n" +
                  "👉 *.figura* – Transformo uma foto em figurinha (manda junto a imagem)\n" +
                  "👉 *.bomdia / .boatarde / .boanoite / .boamadrugada* – Mando uma frase motivacional ✨\n" +
                  "👉 *.evento* – Lista os eventos da semana 📅\n" +
                  "👉 *.todos [mensagem]* – Marca todos do grupo 📢"
        });

        // Frases motivacionais
        if ([".bomdia", ".boatarde", ".boanoite", ".boamadrugada"].includes(cmd)) {
            const frase = await pegarFraseZen();
            await sock.sendMessage(from, { text: `@${m.key.participant?.split('@')[0]} ${frase}`, mentions: [m.key.participant] });
        }

        // Música do YouTube
        if (cmd.startsWith('.tocar ')) {
            const query = text.substring(7).trim();
            await sock.sendMessage(from, { text: `🎵 Buscando e tocando sua música: ${query}` });
            try {
                const result = await ytSearch(query);
                const video = result.videos.length > 0 ? result.videos[0] : null;
                if (!video) {
                    await sock.sendMessage(from, { text: "❌ Não encontrei a música no YouTube." });
                    return;
                }

                const url = video.url;
                const stream = ytdl(url, { filter: 'audioonly', quality: 'highestaudio' });
                const chunks = [];
                stream.on('data', chunk => chunks.push(chunk));
                stream.on('end', async () => {
                    const audioBuffer = Buffer.concat(chunks);
                    await sock.sendMessage(from, { audio: audioBuffer, mimetype: 'audio/mpeg' });
                });
                stream.on('error', async (err) => {
                    console.error("Erro ao baixar áudio:", err);
                    await sock.sendMessage(from, { text: "❌ Ocorreu um erro ao baixar a música." });
                });
            } catch (err) {
                console.error("Erro no .tocar:", err);
                await sock.sendMessage(from, { text: "❌ Ocorreu um erro ao buscar ou tocar a música." });
            }
        }

        // Figura (sticker)
        if (cmd === '.figura') {
            try {
                let buffer;
                if (m.message.imageMessage) {
                    buffer = await sock.downloadMediaMessage(m);
                } else if (m.message.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage) {
                    const quoted = m.message.extendedTextMessage.contextInfo;
                    buffer = await sock.downloadMediaMessage({
                        key: {
                            remoteJid: from,
                            id: quoted.stanzaId,
                            fromMe: false
                        },
                        message: quoted.quotedMessage
                    });
                }

                if (!buffer) {
                    await sock.sendMessage(from, { text: "❌ Não achei nenhuma imagem para transformar em figurinha." });
                    return;
                }

                const webpBuffer = await sharp(buffer).webp().toBuffer();
                await sock.sendMessage(from, { sticker: { url: webpBuffer } });
            } catch (err) {
                console.error("Erro no .figura:", err);
                await sock.sendMessage(from, { text: "❌ Ocorreu um erro ao criar a figurinha." });
            }
        }

        // Comando .evento
        if (cmd === '.evento') {
            const eventos = [
                "Segunda: Começa tudo de novo!",
                "Quinta: Quintas Intenções",
                "Sexta: Happy Hour e Divulga seu trampo aí",
                "Sábado e Domingo: Encontrão - Parque de Madureira"
            ];
            await sock.sendMessage(from, { text: `📅 Eventos da semana:\n\n${eventos.join("\n")}` });
        }

        // Comando .todos
        if (cmd.startsWith('.todos')) {
            try {
                const metadata = await sock.groupMetadata(from);
                const participants = metadata.participants.map(p => p.id);
                const mensagem = text.replace('.todos', '').trim() || "📢 Chamando todo mundo!";
                await sock.sendMessage(from, { text: mensagem, mentions: participants });
            } catch (err) {
                console.error("Erro no .todos:", err);
            }
        }
    });

    // Entrada/saída de participantes
    sock.ev.on('group-participants.update', async (update) => {
        try {
            const metadata = await sock.groupMetadata(update.id);
            for (const participant of update.participants) {
                if (update.action === 'add') {
                    await sock.sendMessage(update.id, { text: `👋 Bem-vindo(a), @${participant.split('@')[0]} ao grupo *${metadata.subject}*!`, mentions: [participant] });
                } else if (update.action === 'invite') {
                    await sock.sendMessage(update.id, { text: `🙌 Bem-vindo(a) de volta, @${participant.split('@')[0]}!`, mentions: [participant] });
                }
            }
        } catch (err) {
            console.error(err);
        }
    });
}

startDobby();
