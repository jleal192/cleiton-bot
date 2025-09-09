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
const playdl = require('play-dl');
const { spawn } = require('child_process');

const MAX_MB = 16;
const MAX_BYTES = MAX_MB * 1024 * 1024;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

async function startDobby() {
  const { state, saveCreds } = await useMultiFileAuthState('dobby_auth');

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false, // QR manual no terminal via qrcode-terminal
    browser: ['Dobby-Bot', 'Chrome', '1.0.0'],
    syncFullHistory: false,
  });

  // QR / conexão
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
        console.log('🚪 Sessão deslogada. Apague a pasta dobby_auth para um novo login.');
      }
    } else if (connection === 'open') {
      console.log('✅ Conectado ao WhatsApp!');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // Helpers
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

  // ========= Pipeline de áudio com fallback (ytdl-core -> play-dl) =========
  const processAudio = async (url, maxDurationSec) => {
    const makeFfmpeg = () =>
      spawn('ffmpeg', ['-i', 'pipe:0', '-t', String(maxDurationSec), '-f', 'mp3', 'pipe:1']);

    const tryYTDL = () =>
      new Promise((resolve, reject) => {
        const ytdlOpts = {
          filter: 'audioonly',
          quality: 'highestaudio',
          highWaterMark: 1 << 25,
          requestOptions: {
            headers: {
              'user-agent': UA,
              ...(process.env.YT_COOKIE ? { cookie: process.env.YT_COOKIE } : {}),
            },
          },
        };

        const ff = makeFfmpeg();
        const chunks = [];
        ff.stdout.on('data', (c) => chunks.push(c));
        ff.stdout.on('end', () => resolve(Buffer.concat(chunks)));
        ff.on('error', reject);
        ff.stderr.on('data', () => {}); // habilite logs para debug

        const s = ytdl(url, ytdlOpts);
        s.on('error', reject);
        s.pipe(ff.stdin);
      });

    const tryPlayDL = async () => {
      try {
        // Tenta autorização (usa cookies locais se configurados; opcional)
        await playdl.authorization();
      } catch (_) {
        // ignore
      }

      const streamInfo = await playdl.stream(url, {
        discordPlayerCompatibility: false,
        quality: 2, // 2 = alta
      });

      return await new Promise((resolve, reject) => {
        const ff = makeFfmpeg();
        const chunks = [];
        ff.stdout.on('data', (c) => chunks.push(c));
        ff.stdout.on('end', () => resolve(Buffer.concat(chunks)));
        ff.on('error', reject);
        ff.stderr.on('data', () => {}); // habilite logs para debug

        streamInfo.stream.on('error', reject).pipe(ff.stdin);
      });
    };

    try {
      return await tryYTDL();
    } catch (e1) {
      console.log('ytdl-core falhou, tentando play-dl:', e1?.statusCode || e1?.message || e1);
      return await tryPlayDL();
    }
  };

  // Mensagens
  sock.ev.on('messages.upsert', async (msg) => {
    try {
      const m = msg.messages?.[0];
      if (!m || !m.message || m.key.fromMe) return;

      const from = m.key.remoteJid;
      const sender = m.key.participant || m.key.remoteJid;
      const text =
        m.message.conversation ||
        m.message.extendedTextMessage?.text ||
        m.message.imageMessage?.caption ||
        '';
      const cmd = text.trim().toLowerCase();

      // Básicos
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

      // Frases motivacionais
      if (['.bomdia', '.boatarde', '.boanoite', '.boamadrugada'].includes(cmd)) {
        const frase = await pegarFraseZen();
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
              audioBuffer = await processAudio(video.url, 150); // 2:30
              picked = video;
            } catch (err) {
              const code = err?.statusCode || err?.message || err;
              console.log(`Erro baixando "${video?.title || video?.url}":`, code);
              tries++;
            }
          }

          if (!audioBuffer) {
            await sock.sendMessage(from, { text: '❌ Não consegui baixar nenhum vídeo 😭' });
            return;
          }

          // Reduz tamanho se passar do limite
          if (audioBuffer.length > MAX_BYTES) {
            try {
              const url = (picked || candidates[tries - 1]).url;
              audioBuffer = await processAudio(url, 90);
              await sock.sendMessage(from, {
                text: '⚠️ Arquivo grande, enviando versão reduzida (1:30 min)...',
              });
            } catch (e) {
              console.log('Falhou na redução de tamanho:', e?.message || e);
            }
          }

          await sock.sendMessage(from, {
            audio: audioBuffer,
            mimetype: 'audio/mpeg',
            ptt: false,
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
          const imgMessage =
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

  // Eventos de grupo
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

// ===== Dicas (comentários) =====
// 1) Instale ffmpeg: sudo apt update && sudo apt install -y ffmpeg
// 2) Atualize libs: npm i ytdl-core@latest play-dl@latest
// 3) (Opcional) usar cookie do YouTube p/ vídeos com restrição:
//    export YT_COOKIE="$(cat yt.cookie)"
// 4) Debug do ffmpeg: troque ff.stderr.on('data',()=>{}) por console.log(...) quando precisar.
