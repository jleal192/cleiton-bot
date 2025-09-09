const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
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

    // Conexão
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            if (reason !== DisconnectReason.loggedOut) {
                console.log("🔄 Eita, Dobby caiu! Reconectando...");
                startDobby();
            } else {
                console.log("❌ Dobby foi deslogado, se cuida aí!");
            }
        } else if (connection === 'open') {
            console.log('✅ Eita, Dobby tá ON! Bora zoar o grupo!');
        }
    });
    sock.ev.on('creds.update', saveCreds);

    // Função para frase motivacional estilo Dobby
    async function pegarFraseZen() {
        try {
            const res = await fetch('https://zenquotes.io/api/random', { headers: { 'User-Agent': 'Mozilla/5.0' } });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (!data || !data[0] || !data[0].q || !data[0].a) throw new Error('Resposta inválida da API');
            return `💭 "${data[0].q}" — ${data[0].a}`;
        } catch {
            return "💡 Fica firme, campeão(a)! Dobby acredita em você!";
        }
    }

    // Função para processar áudio do YouTube
    const processAudio = (url, maxDuration) => new Promise((resolve, reject) => {
        const ffmpegProcess = spawn('ffmpeg', ['-i', 'pipe:0', '-t', maxDuration.toString(), '-f', 'mp3', 'pipe:1']);
        const chunks = [];
        ffmpegProcess.stdout.on('data', chunk => chunks.push(chunk));
        ffmpegProcess.stdout.on('end', () => resolve(Buffer.concat(chunks)));
        ffmpegProcess.on('error', reject);
        ytdl(url, { filter: 'audioonly', quality: 'highestaudio' })
            .on('error', reject)
            .pipe(ffmpegProcess.stdin);
    });

    // Mensagens recebidas
    sock.ev.on('messages.upsert', async (msg) => {
        const m = msg.messages[0];
        if (!m.message || m.key.fromMe) return;
        const from = m.key.remoteJid;
        const text = m.message.conversation || m.message.extendedTextMessage?.text || "";
        const cmd = text.toLowerCase();

        // Comandos simples com estilo Dobby
        if (cmd === '.ping') await sock.sendMessage(from, { text: "🏓 Pong! Dobby tá na área, meu chapa!" });
        if (cmd === '.menu') await sock.sendMessage(from, { text: "📋 Olha só o que o Dobby faz:\n\n👉 .ping – Bora testar se tô vivo\n👉 .menu – Mostra essa belezura\n👉 .help – Me ajuda a te ajudar\n👉 .tocar – Música na veia 🎵\n👉 .figura – Sua foto virando figurinha 🤪\n👉 .bomdia/.boatarde/.boanoite/.boamadrugada – Motivação na veia ✨\n👉 .evento – Agenda do rolê 📅\n👉 .todos – Chama geral 🔊" });
        if (cmd === '.help') await sock.sendMessage(from, { 
            text: "🆘 Dobby Help Style:\n\n" +
                  "👉 *.ping* – Testa se tô vivo (respondo Pong 🏓)\n" +
                  "👉 *.menu* – Mostra o menu estiloso do Dobby\n" +
                  "👉 *.tocar [nome ou link]* – Vou baixar e mandar a música direto 🎶\n" +
                  "👉 *.figura* – Sua imagem vai virar figurinha, óóó 🤪\n" +
                  "👉 *.bomdia / .boatarde / .boanoite / .boamadrugada* – Motivação na hora ✨\n" +
                  "👉 *.evento* – Agenda do rolê da semana 📅\n" +
                  "👉 *.todos [mensagem]* – Chama geral do grupo, bora zoar 🔊"
        });

        // Frases motivacionais estilo Dobby
        if ([".bomdia", ".boatarde", ".boanoite", ".boamadrugada"].includes(cmd)) {
            const frase = await pegarFraseZen();
            await sock.sendMessage(from, { text: `@${m.key.participant?.split('@')[0]} ${frase} 💪 Dobby te dá aquele gás!`, mentions: [m.key.participant] });
        }

        // Música do YouTube com limite de tamanho e retries
        if (cmd.startsWith('.tocar ')) {
            const query = text.substring(7).trim();
            await sock.sendMessage(from, { text: `🎵 Segura aí! Dobby tá procurando sua música: ${query}` });

            try {
                const result = await ytSearch(query);
                if (!result.videos || result.videos.length === 0) {
                    return await sock.sendMessage(from, { text: "❌ Ih, não achei essa música não!" });
                }

                let audioBuffer;
                let success = false;
                let tries = 0;

                while(!success && tries < 5) {
                    const video = result.videos[tries];
                    if (!video) break;

                    await sock.sendMessage(from, { text: `🔎 Tentando baixar: ${video.title} (${video.url})` });

                    try {
                        audioBuffer = await processAudio(video.url, 150); // 2:30 min
                        success = true;
                    } catch (err) {
                        console.error(`Erro tentando baixar "${video.title}":`, err?.statusCode || err.message || err);
                        tries++;
                    }
                }

                if (!success) {
                    return await sock.sendMessage(from, { text: "❌ Não consegui baixar nenhum vídeo dessa música 😭" });
                }

                // Se ainda estiver grande demais, corta para 1:30
                if (audioBuffer.length > MAX_BYTES) {
                    await sock.sendMessage(from, { text: "⚠️ Arquivo muito grande, enviando versão reduzida (1:30 min)..." });
                    audioBuffer = await processAudio(result.videos[tries-1].url, 90);
                }

                await sock.sendMessage(from, { audio: audioBuffer, mimetype: 'audio/mpeg' });
                await sock.sendMessage(from, { text: `🎧 Música entregue pelo Dobby! Aproveita: ${result.videos[tries-1].title}` });

            } catch (err) {
                console.error("Erro geral no .tocar:", err);
                await sock.sendMessage(from, { text: "❌ Ocorreu um erro ao buscar ou tocar a música 😭" });
            }
        }

        // Figura (sticker) estilo Dobby
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
                    await sock.sendMessage(from, { text: "❌ Eita! Não achei nenhuma imagem pra figurinha 😅" });
                    return;
                }

                const webpBuffer = await sharp(buffer).webp().toBuffer();
                await sock.sendMessage(from, { sticker: { url: webpBuffer } });
                await sock.sendMessage(from, { text: "🪄 Tcharam! Figurinha pronta pelo Dobby!" });
            } catch (err) {
                console.error("Erro no .figura:", err);
                await sock.sendMessage(from, { text: "❌ Deu ruim criando a figurinha 😭" });
            }
        }

        // Comando .evento estilo Dobby
        if (cmd === '.evento') {
            const eventos = [
                "Segunda: Segunda é segunda, mas bora lá! 💪",
                "Quinta: Quintas Intenções - quase sexta! 😎",
                "Sexta: Happy Hour + Divulga teu trampo! 🍻",
                "Sábado e Domingo: Encontrão - Parque de Madureira 🌳"
            ];
            await sock.sendMessage(from, { text: `📅 Agenda do rolê:\n\n${eventos.join("\n")}` });
        }

        // Comando .todos estilo Dobby
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

    // Entrada/saída de participantes estilo Dobby
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
