const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadContentFromMessage } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const fetch = require('node-fetch');
const ytdl = require('ytdl-core');
const ytSearch = require('yt-search');
const sharp = require('sharp');
const { spawn } = require('child_process');
const MAX_MB = 16;
const MAX_BYTES = MAX_MB * 1024 * 1024;

async function startDobby() {
    const { state, saveCreds } = await useMultiFileAuthState('dobby_auth');
    const sock = makeWASocket({ auth: state });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            if (reason !== DisconnectReason.loggedOut) startDobby();
        }
    });
    sock.ev.on('creds.update', saveCreds);

    async function pegarFraseZen() {
        try {
            const res = await fetch('https://zenquotes.io/api/random', { headers: { 'User-Agent': 'Mozilla/5.0' } });
            const data = await res.json();
            return `💭 "${data[0].q}" — ${data[0].a}`;
        } catch {
            return "💡 Fica firme, campeão(a)! Dobby acredita em você!";
        }
    }

    const processAudio = (url, maxDuration) => new Promise((resolve, reject) => {
        const ffmpegProcess = spawn('ffmpeg', ['-i', 'pipe:0', '-t', maxDuration.toString(), '-f', 'mp3', 'pipe:1']);
        const chunks = [];
        ffmpegProcess.stdout.on('data', c => chunks.push(c));
        ffmpegProcess.stdout.on('end', () => resolve(Buffer.concat(chunks)));
        ffmpegProcess.on('error', reject);

        ytdl(url, { filter: 'audioonly', quality: 'highestaudio' })
            .on('error', reject)
            .pipe(ffmpegProcess.stdin);
    });

    sock.ev.on('messages.upsert', async (msg) => {
        const m = msg.messages[0];
        if (!m.message || m.key.fromMe) return;
        const from = m.key.remoteJid;
        const text = m.message.conversation || m.message.extendedTextMessage?.text || "";
        const cmd = text.toLowerCase();

        // Comandos básicos
        if (cmd === '.ping') await sock.sendMessage(from, { text: "🏓 Pong! Dobby tá na área!" });
        if (cmd === '.menu') await sock.sendMessage(from, { text: "📋 Comandos do Dobby:\n.tocar, .figura, .bomdia/.boatarde/.boanoite, .evento, .todos" });
        if (cmd === '.help') await sock.sendMessage(from, { text: "🆘 .ping, .menu, .tocar [nome/url], .figura, .bomdia/.boatarde/.boanoite/.boamadrugada, .evento, .todos [msg]" });

        // Frases motivacionais
        if ([".bomdia", ".boatarde", ".boanoite", ".boamadrugada"].includes(cmd)) {
            const frase = await pegarFraseZen();
            await sock.sendMessage(from, { text: `@${m.key.participant?.split('@')[0]} ${frase} 💪`, mentions: [m.key.participant] });
        }

        // .tocar
        if (cmd.startsWith('.tocar ')) {
            const query = text.substring(7).trim();
            await sock.sendMessage(from, { text: `🎵 Procurando: ${query}` });

            try {
                const result = await ytSearch(query);
                if (!result.videos || result.videos.length === 0) return sock.sendMessage(from, { text: "❌ Não achei essa música!" });

                let audioBuffer, success = false, tries = 0;
                while(!success && tries < result.videos.length) {
                    const video = result.videos[tries];
                    try {
                        audioBuffer = await processAudio(video.url, 150); // 2:30 min
                        success = true;
                    } catch (err) {
                        console.log(`Erro baixando "${video.title}":`, err?.statusCode || err.message || err);
                        tries++;
                    }
                }

                if (!success) return sock.sendMessage(from, { text: "❌ Não consegui baixar nenhum vídeo 😭" });

                if (audioBuffer.length > MAX_BYTES) {
                    audioBuffer = await processAudio(result.videos[tries-1].url, 90);
                    await sock.sendMessage(from, { text: "⚠️ Arquivo grande, enviando versão reduzida (1:30 min)..." });
                }

                await sock.sendMessage(from, { audio: audioBuffer, mimetype: 'audio/mpeg' });
                await sock.sendMessage(from, { text: `🎧 Aqui está: ${result.videos[tries-1].title}` });

            } catch (err) {
                console.error("Erro no .tocar:", err);
                await sock.sendMessage(from, { text: "❌ Erro ao buscar ou tocar música 😭" });
            }
        }

        // .figura
        if (cmd === '.figura') {
            try {
                let buffer;

                if (m.message.imageMessage) {
                    const stream = await downloadContentFromMessage(m.message.imageMessage, 'image');
                    buffer = Buffer.concat([]);
                    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                } else if (m.message.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage) {
                    const quoted = m.message.extendedTextMessage.contextInfo.quotedMessage.imageMessage;
                    const stream = await downloadContentFromMessage(quoted, 'image');
                    buffer = Buffer.concat([]);
                    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                }

                if (!buffer || buffer.length === 0) return await sock.sendMessage(from, { text: "❌ Nenhuma imagem encontrada 😅" });

                const webpBuffer = await sharp(buffer).webp().toBuffer();
                await sock.sendMessage(from, { sticker: { url: webpBuffer } });
                await sock.sendMessage(from, { text: "🪄 Figurinha pronta!" });

            } catch (err) {
                console.error("Erro no .figura:", err);
                await sock.sendMessage(from, { text: "❌ Deu ruim criando a figurinha 😭" });
            }
        }

        // .evento
        if (cmd === '.evento') {
            const eventos = [
                "Segunda: Segunda é segunda, mas bora lá! 💪",
                "Quinta: Quintas Intenções - quase sexta! 😎",
                "Sexta: Happy Hour + Divulga teu trampo! 🍻",
                "Sábado e Domingo: Encontrão - Parque de Madureira 🌳"
            ];
            await sock.sendMessage(from, { text: `📅 Agenda do rolê:\n\n${eventos.join("\n")}` });
        }

        // .todos
        if (cmd.startsWith('.todos')) {
            try {
                const metadata = await sock.groupMetadata(from);
                const participants = metadata.participants.map(p => p.id);
                const mensagem = text.replace('.todos', '').trim() || "📢 Bora todo mundo ouvir o Dobby!";
                await sock.sendMessage(from, { text: mensagem, mentions: participants });
            } catch (err) {
                console.error("Erro no .todos:", err);
            }
        }
    });

    sock.ev.on('group-participants.update', async (update) => {
        try {
            const metadata = await sock.groupMetadata(update.id);
            for (const participant of update.participants) {
                if (update.action === 'add') {
                    await sock.sendMessage(update.id, { text: `👋 E aí @${participant.split('@')[0]}, chegou chegando no grupo *${metadata.subject}*! 😎`, mentions: [participant] });
                } else if (update.action === 'invite') {
                    await sock.sendMessage(update.id, { text: `🙌 Olha quem voltou! @${participant.split('@')[0]} 😏`, mentions: [participant] });
                }
            }
        } catch (err) {
            console.error(err);
        }
    });
}

startDobby();
