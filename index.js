// Dobby Bot — versão yt-dlp + ffmpeg (sem play-dl / ytdl-core)
// Stack: Baileys + yt-dlp + ffmpeg + sharp
// Observação: certifique-se de ter yt-dlp e ffmpeg instalados no servidor.

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadContentFromMessage,
} = require('@whiskeysockets/baileys');

const fetch = require('node-fetch');
const ytSearch = require('yt-search');
const sharp = require('sharp');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Evita warning de MaxListenersExceeded
require('events').defaultMaxListeners = 30;

const MAX_MB = 16;
const MAX_BYTES = MAX_MB * 1024 * 1024;

// ==== Helpers ================================================================

function tempFile(suffix = '') {
  const name = `dobby_${Date.now()}_${Math.random().toString(36).slice(2)}${suffix}`;
  return path.join(os.tmpdir(), name);
}

// Frase motivacional em PT-BR
async function pegarFraseZen() {
  try {
    const res = await fetch('https://zenquotes.io/api/random', {
      headers: { 'User-Agent': 'Mozilla/5.0 (DobbyBot)' },
      timeout: 12_000,
    });
    const data = await res.json();
    const en = `${data?.[0]?.q} — ${data?.[0]?.a}`;

    // traduz para PT-BR via API livre
    const tr = await fetch(
      'https://api.mymemory.translated.net/get?q=' +
        encodeURIComponent(en) +
        '&langpair=en|pt-BR'
    );
    const trJson = await tr.json();
    const translated = trJson?.responseData?.translatedText || en;

    return `💭 ${translated}`;
  } catch {
    return '💡 Continue firme, você é capaz de vencer qualquer desafio!';
  }
}

// Executa comando (spawn)
function execSpawn(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);

    p.stdout.on('data', (d) => (stdout = Buffer.concat([stdout, d])));
    p.stderr.on('data', (d) => (stderr = Buffer.concat([stderr, d])));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited with ${code}: ${stderr.toString()}`));
    });
  });
}

// Baixar áudio de um URL do YouTube (com suporte a cookies.txt)
async function baixarAudioMP3(url, maxDurationSec = 150, targetBitrate = '128k') {
  const cookiesPath = path.join(__dirname, 'cookies.txt');

  const ytdlpArgs = [
    '-f',
    'bestaudio/best',
    '--no-playlist',
    '--geo-bypass',
    '--force-ipv4',
    '--no-warnings',
    ...(fs.existsSync(cookiesPath) ? ['--cookies', cookiesPath] : []), // usa cookies se existir
    '-o',
    '-',
    url,
  ];

  const userAgent =
    process.env.YTDLP_USER_AGENT ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

  const outFile = tempFile('.mp3');
  return new Promise((resolve, reject) => {
    const ytdlp = spawn('yt-dlp', ytdlpArgs, {
      env: { ...process.env, HTTP_USER_AGENT: userAgent },
    });

    const ffmpegArgs = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'pipe:0',
      '-t',
      String(maxDurationSec),
      '-vn',
      '-ac',
      '2',
      '-ar',
      '44100',
      '-b:a',
      targetBitrate,
      '-f',
      'mp3',
      outFile,
    ];
    const ffmpegProc = spawn('ffmpeg', ffmpegArgs);

    let stderrF = '';
    ytdlp.stderr.on('data', () => {});
    ffmpegProc.stderr.on('data', (d) => (stderrF += d.toString()));

    ytdlp.stdout.pipe(ffmpegProc.stdin);

    ffmpegProc.on('close', (code) => {
      try {
        ytdlp.kill('SIGKILL');
      } catch {}
      if (code !== 0) return reject(new Error(`ffmpeg falhou: ${stderrF}`));
      try {
        const buf = fs.readFileSync(outFile);
        fs.unlink(outFile, () => {});
        resolve(buf);
      } catch (err) {
        reject(err);
      }
    });
  });
}

// Buscar no YouTube e tentar baixar
async function baixarPorBusca(query, tentativaDurSeg = [150, 120, 90]) {
  const result = await ytSearch(query);
  const vids = (result && result.videos) || [];
  if (!vids.length) throw new Error('Nenhum vídeo encontrado');

  const maxCandidates = Math.min(6, vids.length);
  let lastErr = null;

  for (let i = 0; i < maxCandidates; i++) {
    const v = vids[i];
    for (const dur of tentativaDurSeg) {
      try {
        const buf = await baixarAudioMP3(v.url, dur, '128k');
        if (buf && buf.length > 0)
          return { buffer: buf, title: v.title, url: v.url };
      } catch (e) {
        lastErr = e;
      }
    }
  }
  throw lastErr || new Error('Falhou em todas as tentativas');
}

// Criar figurinha
async function criarFigurinha(sock, m, from) {
  let buffer;

  if (m.message?.imageMessage) {
    const stream = await downloadContentFromMessage(
      m.message.imageMessage,
      'image'
    );
    buffer = Buffer.concat([]);
    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
  }

  if (
    !buffer &&
    m.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage
  ) {
    const quoted =
      m.message.extendedTextMessage.contextInfo.quotedMessage.imageMessage;
    const stream = await downloadContentFromMessage(quoted, 'image');
    buffer = Buffer.concat([]);
    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
  }

  if (!buffer || buffer.length === 0) {
    await sock.sendMessage(from, { text: '❌ Nenhuma imagem encontrada 😅' });
    return;
  }

  const webpBuffer = await sharp(buffer).webp({ quality: 90 }).toBuffer();
  await sock.sendMessage(from, { sticker: webpBuffer });
  await sock.sendMessage(from, { text: '🪄 Figurinha criada!' });
}

// ==== Bot ====================================================================

async function startDobby() {
  const { state, saveCreds } = await useMultiFileAuthState('dobby_auth');
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const reason =
        lastDisconnect?.error?.output?.statusCode ||
        lastDisconnect?.error?.message;
      console.log(`⚠️ Conexão fechada: ${reason}`);
      if (reason !== DisconnectReason.loggedOut) {
        console.log('🔁 Tentando reconectar...');
        startDobby();
      }
    } else if (connection === 'open') {
      console.log('✅ Conectado ao WhatsApp!');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // Menu e Ajuda
  const MENU_TXT = [
    '🧙‍♂️ **Dobby Menu**',
    '━━━━━━━━━━━━━━',
    '⚡ .ping — teste de vida',
    '🎧 .tocar <música/artista> — NÃO FUNCIONA (EM BREVE)',
    '🖼️ .figura — transforma imagem/reply em figurinha',
    '🌞 .bomdia | 🌇 .boatarde | 🌙 .boanoite | 🌃 .boamadrugada — frases estilo Mabel',
    '📅 .eventos — agenda do rolê',
    '📣 .todos [mensagem] — menciona geral (grupos)',
  ].join('\n');

  const HELP_TXT = [
    '🆘 **Ajuda do Dobby**',
    '━━━━━━━━━━━━━━',
    '• Use `.tocar` com nome da música/artista. Ex: `.tocar pentatonix hallelujah`',
    '• Para `.figura`, envie uma imagem ou responda uma imagem com `.figura`',
    `• Limite de tamanho de áudio: ${MAX_MB} MB (~2:30 min).`,
    '• Em grupo, `.todos Sua mensagem` chama a tropa inteira.',
  ].join('\n');

  // Comandos
  sock.ev.on('messages.upsert', async (ev) => {
    const m = ev.messages?.[0];
    if (!m || !m.message || m.key.fromMe) return;

    const from = m.key.remoteJid;
    const text =
      m.message?.conversation ||
      m.message?.extendedTextMessage?.text ||
      m.message?.imageMessage?.caption ||
      '';
    const cmd = text.trim().toLowerCase();

    try {
      if (cmd === '.ping') {
        await sock.sendMessage(from, { text: '🏓 Pong! Dobby online.' });
        return;
      }
      if (cmd === '.menu') {
        await sock.sendMessage(from, { text: MENU_TXT });
        return;
      }
      if (cmd === '.help') {
        await sock.sendMessage(from, { text: HELP_TXT });
        return;
      }

      if (['.bomdia', '.boatarde', '.boanoite', '.boamadrugada'].includes(cmd)) {
        const frase = await pegarFraseZen();
        const mention = m.key.participant || m.participant || m.pushName;
        const tag = mention?.split('@')?.[0];
        await sock.sendMessage(from, {
          text: `@${tag} ${frase} 💪`,
          mentions: mention ? [mention] : [],
        });
        return;
      }

      if (cmd.startsWith('.tocar ')) {
        const query = text.slice(7).trim();
        if (!query) {
          await sock.sendMessage(from, {
            text: '❗ Use: `.tocar <música/artista>`',
          });
          return;
        }
        await sock.sendMessage(from, { text: `🎵 Procurando: *${query}*…` });

        try {
          const { buffer, title } = await baixarPorBusca(query);

          let audioBuffer = buffer;
          if (audioBuffer.length > MAX_BYTES) {
            const tmpIn = tempFile('.in.mp3');
            const tmpOut = tempFile('.out.mp3');
            fs.writeFileSync(tmpIn, audioBuffer);
            await execSpawn('ffmpeg', [
              '-hide_banner',
              '-loglevel',
              'error',
              '-t',
              '90',
              '-i',
              tmpIn,
              '-vn',
              '-ac',
              '2',
              '-ar',
              '44100',
              '-b:a',
              '96k',
              '-f',
              'mp3',
              tmpOut,
            ]);
            audioBuffer = fs.readFileSync(tmpOut);
            fs.unlink(tmpIn, () => {});
            fs.unlink(tmpOut, () => {});
            await sock.sendMessage(from, {
              text: '⚠️ Arquivo grande — enviando versão reduzida (1:30 min)…',
            });
          }

          await sock.sendMessage(from, {
            audio: audioBuffer,
            mimetype: 'audio/mpeg',
          });
          await sock.sendMessage(from, { text: `🎧 Aqui está: *${title}*` });
        } catch (err) {
          const msg = String(err?.message || err);
          if (/consent|not a bot|410|sign in/i.test(msg)) {
            await sock.sendMessage(from, {
              text: '❌ O YouTube bloqueou essa busca.\n↪️ Tente outro título/versão (ao vivo, lyric, etc).',
            });
          } else {
            await sock.sendMessage(from, {
              text: '❌ Erro ao buscar ou tocar música 😭',
            });
          }
          console.error('Erro no .tocar:', msg);
        }
        return;
      }

      if (cmd === '.figura') {
        try {
          await criarFigurinha(sock, m, from);
        } catch (err) {
          console.error('Erro no .figura:', err?.message || err);
          await sock.sendMessage(from, {
            text: '❌ Deu erro criando a figurinha 😭',
          });
        }
        return;
      }

      if (cmd === '.eventos') {
        const eventos = [
          '📅 **Agenda do rolê**',
          '━━━━━━━━━━━━━━',
          '💪 Segunda: Começar no gás!',
          '😎 Quinta: Quintas Intenções — quase sexta!',
          '🍻 Sexta: Happy Hour + divulgação de projetos!',
          '🌳 Sábado & Domingo: Encontrão no Parque de Madureira',
        ].join('\n');
        await sock.sendMessage(from, { text: eventos });
        return;
      }

      if (cmd.startsWith('.todos')) {
        try {
          const metadata = await sock.groupMetadata(from);
          const participants = metadata.participants.map((p) => p.id);
          const mensagem =
            text.replace('.todos', '').trim() ||
            '📢 Bora todo mundo ouvir o Dobby!';
          await sock.sendMessage(from, { text: mensagem, mentions: participants });
        } catch {
          await sock.sendMessage(from, {
            text: '❌ Esse comando só funciona em grupos.',
          });
        }
        return;
      }

      if (cmd === '.tocar') {
        await sock.sendMessage(from, {
          text: '❗ Use: `.tocar <música/artista>`',
        });
      }
    } catch (e) {
      console.error('Erro geral:', e?.message || e);
    }
  });

  sock.ev.on('group-participants.update', async (update) => {
    try {
      const metadata = await sock.groupMetadata(update.id);
      for (const participant of update.participants) {
        if (update.action === 'add') {
          await sock.sendMessage(update.id, {
            text: `👋 Bem-vindo @${participant.split('@')[0]} ao grupo *${metadata.subject}*! 🎉`,
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
      console.error(err);
    }
  });
}

startDobby();
