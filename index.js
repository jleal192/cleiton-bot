// index.js
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadContentFromMessage,
} = require('@whiskeysockets/baileys');

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

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false, // vamos renderizar o QR manualmente
    browser: ['Dobby-Bot', 'Chrome', '1.0.0'],
    syncFullHistory: false,
  });

  // === QR code no terminal ===
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('📲 Escaneie o QR para logar:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.message;
      console.log('⚠️ Conexão fechada:', reason);
      if (reason !== DisconnectReason.loggedOut) {
        console.log('🔁 Tentando reconectar...');
        startDobby();
      } else {
        console.log('🚪 Sessão deslogada. Exclua a pasta dobby_auth se quiser iniciar novo login.');
      }
    } else if (connection === 'open') {
      console.log('✅ Conectado ao WhatsApp!');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // === Helpers ===
  async function pegarFraseZen() {
    try {
      const res = await fetch('https://zenquotes.io/api/random', {
        headers: { 'User-Agent': 'Mozilla/5.0 (DobbyBot)' },
        timeout: 12_000,
      });
      const data = await res.json();
      if (Array.isArray(data) && data[0]?.q && data[0]?.a) {
        return `💭 "${data[0].q}" — ${data[0].a}`;
      }
      return '💡 Fica firme, campeão(a)! Dobby acredita em você!';
    } catch (e) {
      console.error('Erro pegarFraseZen:', e?.message || e);
      return '💡 Fica firme, campeão(a)! Dobby acredita em você!';
    }
  }

  // Baixa áudio do YouTube e corta com ffmpeg (buffer mp3)
  const processAudio = (url, maxDurationSec) =>
    new Promise((resolve, reject) => {
      try {
        const ffmpegArgs = ['-i', 'pipe:0', '-t', String(maxDurationSec), '-f', 'mp3', 'pipe:1'];
        const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

        const chunks = [];
        ffmpegProcess.stdout.on('data', (c) => chunks.push(c));
        ffmpegProcess.stdout.on('end', () => resolve(Buffer.concat(chunks)));
        ffmpegProcess.on('error', (err) => reject(err));
        ffmpegProcess.stderr.on('data', (d) => {
          // útil p/ debug se algo der ruim
          // console.log('ffmpeg:', d.toString());
        });

        const stream = ytdl(url, {
          filter: 'audioonly',
          quality: 'highestaudio',
          highWaterMark: 1 << 25, // evita throttling
        });

        stream.on('error', (err) => reject(err));
        stream.pipe(ffmpegProcess.stdin);
      } catch (err) {
        reject(err);
      }
    });

  // === Handlers de mensagens ===
  sock.ev.on('messages.upsert', async (msg) => {
    try {
      const m = msg.messages?.[0];
      if (!m || !m.message || m.key.fromMe) return;

      const from = m.key.remoteJid;
      const sender = m.key.participant || m.key.remoteJid; // grupo ou PV
      const text =
        m.message.conversation ||
        m.message.extendedTextMessage?.text ||
        m.message.imageMessage?.caption ||
        '';
      const cmd = text.trim().toLowerCase();

      // ===== Comandos básicos =====
      if (cmd === '.ping') {
        await sock.sendMessage(from, { text: '🏓 Pong! Dobby tá na área!' });
        return;
      }

      if (cmd === '.menu') {
        await sock.sendMessage(from, {
          text:
            '📋 Comandos do Dobby:\n' +
            '.tocar [nome/url]\n' +
            '.figura (responda uma imagem)\n' +
            '.bomdia / .boatarde / .boanoite / .boamadrugada\n' +
            '.evento\n' +
            '.todos [mensagem]',
        });
        return;
      }

      if (cmd === '.help') {
        await sock.sendMessage(from, {
          text:
            '🆘 Ajuda:\n' +
            '.ping, .menu, .tocar [nome/url], .figura, .bomdia/.boatarde/.boanoite/.boamadrugada, .evento, .todos [msg]',
        });
        return;
      }

      // ===== Frases motivacionais =====
      if (['.bomdia', '.boatarde', '.boanoite', '.boamadrugada'].includes(cmd)) {
        const frase = await pegarFraseZen();
        // só menciona se for grupo e tiver participant
        const mentionId = m.key.participant || undefined;
        await sock.sendMessage(from, {
          text: `${mentionId ? '@' + mentionId.split('@')[0] + ' ' : ''}${frase} 💪`,
          mentions: mentionId ? [mentionId] : [],
        });
        return;
      }

      // ======= .tocar =======
      if (cmd.startsWith('.tocar ')) {
        const query = text.substring(7).trim();
        await sock.sendMessage(from, { text: `🎵 Procurando: ${query}` });

        try {
          // Se já for URL do YouTube válida, prioriza ela
          let candidates = [];
          if (ytdl.validateURL(query)) {
            candidates = [{ url: query, title: 'Link direto' }];
          } else {
            const result = await ytSearch(query);
            if (!result?.videos?.length) {
              await sock.sendMessage(from, { text: '❌ Não achei essa música!' });
              return;
            }
            candidates = result.videos;
          }

          let audioBuffer = null;
          let picked = null;
          let tries = 0;

          while (!audioBuffer && tries < candidates.length) {
            const video = candidates[tries];
            try {
              // 150s (2:30) padrão
              audioBuffer = await processAudio(video.url, 150);
              picked = video;
            } catch (err) {
              console.log(`Erro baixando "${video?.title || video?.url}":`, err?.message || err);
              tries++;
            }
          }

          if (!audioBuffer) {
            await sock.sendMessage(from, { text: '❌ Não consegui baixar nenhum vídeo 😭' });
            return;
          }

          // se ultrapassar 16MB, tenta versão 90s
          if (audioBuffer.length > MAX_BYTES) {
            try {
              audioBuffer = await processAudio((picked || candidates[tries - 1]).url, 90);
              await sock.sendMessage(from, {
                text: '⚠️ Arquivo grande, enviando versão reduzida (1:30 min)...',
              });
            } catch (e) {
              console.log('Falhou na redução de tamanho:', e?.message || e);
            }
          }

          // === CONSERTO: enviar buffer direto no campo "audio" ===
          await sock.sendMessage(from, {
            audio: audioBuffer,
            mimetype: 'audio/mpeg',
            ptt: false, // true para enviar como PTT (áudio de voz)
          });

          if (picked?.title) {
            await sock.sendMessage(from, { text: `🎧 Aqui está: ${picked.title}` });
          }
        } catch (err) {
          console.error('Erro no .tocar:', err);
          await sock.sendMessage(from, { text: '❌ Erro ao buscar ou tocar música 😭' });
        }
        return;
      }

      // ======= .figura =======
      if (cmd === '.figura') {
        try {
          // tenta pegar a imagem da própria msg
          let imgMessage =
            m.message?.imageMessage ||
            m.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage ||
            null;

          if (!imgMessage) {
            await sock.sendMessage(from, { text: '❌ Nenhuma imagem encontrada 😅' });
            return;
          }

          const stream = await downloadContentFromMessage(imgMessage, 'image');
          let buffer = Buffer.concat([]);
          for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);

          if (!buffer?.length) {
            await sock.sendMessage(from, { text: '❌ Falha ao ler imagem 😅' });
            return;
          }

          // === CONSERTO: gerar WEBP e enviar buffer diretamente no campo "sticker" ===
          const webpBuffer = await sharp(buffer)
            .resize(512, 512, { fit: 'inside' })
            .webp({ quality: 90 })
            .toBuffer();

          await sock.sendMessage(from, { sticker: webpBuffer });
          await sock.sendMessage(from, { text: '🪄 Figurinha pronta!' });
        } catch (err) {
          console.error('Erro no .figura:', err?.message || err);
          await sock.sendMessage(from, { text: '❌ Deu ruim criando a figurinha 😭' });
        }
        return;
      }

      // ======= .evento =======
      if (cmd === '.evento') {
        const eventos = [
          'Segunda: Segunda é segunda, mas bora lá! 💪',
          'Quinta: Quintas Intenções - quase sexta! 😎',
          'Sexta: Happy Hour + Divulga teu trampo! 🍻',
          'Sábado e Domingo: Encontrão - Parque de Madureira 🌳',
        ];
        await sock.sendMessage(from, { text: `📅 Agenda do rolê:\n\n${eventos.join('\n')}` });
        return;
      }

      // ======= .todos =======
      if (cmd.startsWith('.todos')) {
        try {
          const isGroup = from.endsWith('@g.us');
          if (!isGroup) {
            await sock.sendMessage(from, { text: '❌ Comando disponível apenas em grupos.' });
            return;
          }
          const metadata = await sock.groupMetadata(from);
          const participants = metadata.participants.map((p) => p.id);
          const mensagem = text.replace('.todos', '').trim() || '📢 Bora todo mundo ouvir o Dobby!';
          await sock.sendMessage(from, { text: mensagem, mentions: participants });
        } catch (err) {
          console.error('Erro no .todos:', err?.message || err);
        }
        return;
      }
    } catch (e) {
      console.error('Erro geral no messages.upsert:', e?.message || e);
    }
  });

  // Sauda usuário ao entrar/voltar no grupo
  sock.ev.on('group-participants.update', async (update) => {
    try {
      const metadata = await sock.groupMetadata(update.id);
      for (const participant of update.participants) {
        if (update.action === 'add') {
          await sock.sendMessage(update.id, {
            text: `👋 E aí @${participant.split('@')[0]}, chegou chegando no grupo *${metadata.subject}*! 😎`,
            mentions: [participant],
          });
        } else if (update.action === 'invite') {
          await sock.sendMessage(update.id, {
            text: `🙌 Olha quem voltou! @${participant.split('@')[0]} 😏`,
            mentions: [participant],
          });
        }
      }
    } catch (err) {
      console.error('Erro em group-participants.update:', err?.message || err);
    }
  });
}

startDobby();

// ===== Dicas de Deploy (comentários) =====
// 1) Instale o ffmpeg na VPS (Ubuntu/Debian):
//    sudo apt update && sudo apt install ffmpeg -y
// 2) Garanta que as portas de saída estão liberadas (YouTube).
// 3) Se o ytdl-core bloquear, atualize: npm i ytdl-core@latest
// 4) Logs úteis: habilite prints do ffmpeg stderr se precisar depurar.
