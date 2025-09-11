// Dobby Bot — versão yt-dlp + ffmpeg (robusta)
// Stack: Baileys + yt-dlp + ffmpeg + sharp + node-cron
// Requisitos no servidor: ffmpeg e yt-dlp (ou python3 -m yt_dlp) instalados.

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadContentFromMessage,
} = require('@whiskeysockets/baileys');

const fetch = require('node-fetch');
const ytSearch = require('yt-search');
const sharp = require('sharp');
const qrcode = require('qrcode-terminal');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cron = require('node-cron');

require('events').defaultMaxListeners = 30;

const MAX_MB = 16;
const MAX_BYTES = MAX_MB * 1024 * 1024;
const niversPath = path.join(__dirname, "nivers.json");

// ==== Helpers ================================================================
function tempFile(suffix = '') {
  const name = `dobby_${Date.now()}_${Math.random().toString(36).slice(2)}${suffix}`;
  return path.join(os.tmpdir(), name);
}

// Resolve caminho do yt-dlp (ajuda quando PM2 não tem PATH completo)
function getYtDlpPath() {
  if (process.env.YTDLP_PATH && fs.existsSync(process.env.YTDLP_PATH)) {
    return process.env.YTDLP_PATH;
  }
  const candidates = [
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
    path.join(os.homedir(), '.local/bin/yt-dlp'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'yt-dlp'; // confia no PATH
}

// Se o arquivo final passar de 16MB, re-encode para bitrate menor
function transcodeIfTooBig(inPath, maxBytes, bitrate = '96k') {
  return new Promise((resolve, reject) => {
    const stats = fs.statSync(inPath);
    if (stats.size <= maxBytes) return resolve(inPath);

    const outPath = inPath.replace(/\.mp3$/i, `.shrunk.mp3`);
    const ff = spawn('ffmpeg', ['-y', '-i', inPath, '-vn', '-b:a', bitrate, outPath]);
    let err = '';
    ff.stderr.on('data', d => err += d.toString());
    ff.on('close', code => {
      if (code !== 0) return reject(new Error('ffmpeg transcode falhou: ' + err.slice(-400)));
      try {
        const s2 = fs.statSync(outPath);
        if (s2.size > maxBytes) {
          return reject(new Error(`Arquivo ainda > ${MAX_MB}MB mesmo após transcode.`));
        }
        fs.unlinkSync(inPath);
        resolve(outPath);
      } catch (e) { reject(e); }
    });
  });
}

// Carregar/salvar aniversários
function carregarNivers() {
  if (!fs.existsSync(niversPath)) return {};
  return JSON.parse(fs.readFileSync(niversPath, "utf8"));
}
function salvarNivers(data) {
  fs.writeFileSync(niversPath, JSON.stringify(data, null, 2));
}

// Frase motivacional em PT-BR
async function pegarFraseZen() {
  try {
    const res = await fetch('https://zenquotes.io/api/random');
    const data = await res.json();
    const en = `${data?.[0]?.q} — ${data?.[0]?.a}`;

    // Traduz via API MyMemory (força PT-BR)
    const tr = await fetch(
      'https://api.mymemory.translated.net/get?q=' +
        encodeURIComponent(en) +
        '&langpair=en|pt-BR'
    );
    const trJson = await tr.json();
    let translated = trJson?.responseData?.translatedText;

    if (!translated || translated.trim().length < 3) {
      translated = '💡 Continue firme, você é capaz de vencer qualquer desafio!';
    }

    return `💭 ${translated}`;
  } catch {
    return '💡 Continue firme, você é capaz de vencer qualquer desafio!';
  }
}

// Baixar áudio (yt-dlp -> mp3) com log do erro + fallback + re-encode se > 16MB
async function baixarAudioMP3(url) {
  const ytdlpBin = getYtDlpPath();
  const tmpDir = os.tmpdir();
  const template = path.join(tmpDir, `dobby_%(id)s.%(ext)s`);

  // 🔽 NOVO: detectar cookies do env ou cookies.txt local
  const cookiesPath = process.env.YTDLP_COOKIES || path.join(__dirname, 'cookies.txt');
  const hasCookies = fs.existsSync(cookiesPath);

  return new Promise((resolve, reject) => {
    const args = [
      '-x', '--audio-format', 'mp3',
      '--no-playlist',
      '--audio-quality', '5',          // VBR moderado => arquivos menores
      '--restrict-filenames',
      '-o', template,
      '--print', 'after_move:filepath',// imprime caminho final do mp3
      '--no-progress',
      // 🔽 NOVO: aplicar cookies se existir
      ...(hasCookies ? ['--cookies', cookiesPath] : []),
      url
    ];

    let stdout = '', stderr = '';
    const y = spawn(ytdlpBin, args);

    y.stdout.on('data', d => stdout += d.toString());
    y.stderr.on('data', d => stderr += d.toString());

    // Se falhar em spawnar o binário, tenta via python3 -m yt_dlp
    y.on('error', () => {
      const y2 = spawn('python3', ['-m', 'yt_dlp', ...args]);
      y2.stdout.on('data', d => stdout += d.toString());
      y2.stderr.on('data', d => stderr += d.toString());
      y2.on('close', async (code) => {
        if (code !== 0) return reject(new Error('yt-dlp falhou: ' + stderr.slice(-400)));
        try {
          const outPath = stdout.trim().split('\n').pop();
          const finalPath = await transcodeIfTooBig(outPath, MAX_BYTES, '96k');
          const buf = fs.readFileSync(finalPath);
          fs.unlinkSync(finalPath);
          resolve(buf);
        } catch (e) { reject(e); }
      });
    });

    y.on('close', async (code) => {
      if (code !== 0) return reject(new Error('yt-dlp falhou: ' + stderr.slice(-400)));
      try {
        const outPath = stdout.trim().split('\n').pop();
        const finalPath = await transcodeIfTooBig(outPath, MAX_BYTES, '96k');
        const buf = fs.readFileSync(finalPath);
        fs.unlinkSync(finalPath);
        resolve(buf);
      } catch (e) { reject(e); }
    });
  });
}

// Buscar no YouTube e baixar áudio
async function baixarPorBusca(query) {
  const result = await ytSearch(query);
  const vids = (result && result.videos) || [];
  if (!vids.length) throw new Error('Nenhum vídeo encontrado');

  for (const v of vids.slice(0, 3)) { // tenta até 3 resultados
    try {
      const buf = await baixarAudioMP3(v.url);
      if (buf) return { buffer: buf, title: v.title };
    } catch (err) {
      console.error(`Erro ao baixar ${v.title}:`, err.message);
    }
  }
  throw new Error("Falha ao baixar áudio");
}

// Criar figurinha
async function criarFigurinha(sock, m, from) {
  try {
    let buffer;
    if (m.message?.imageMessage) {
      const stream = await downloadContentFromMessage(m.message.imageMessage, 'image');
      buffer = Buffer.concat([]);
      for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
    }
    if (!buffer && m.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage) {
      const quoted = m.message.extendedTextMessage.contextInfo.quotedMessage.imageMessage;
      const stream = await downloadContentFromMessage(quoted, 'image');
      buffer = Buffer.concat([]);
      for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
    }
    if (!buffer) return sock.sendMessage(from, { text: '❌ Nenhuma imagem encontrada 😅' });
    const webpBuffer = await sharp(buffer).webp({ quality: 90 }).toBuffer();
    await sock.sendMessage(from, { sticker: webpBuffer });
    await sock.sendMessage(from, { text: '🪄 Figurinha criada!' });
  } catch (err) {
    console.error("Erro no .figura:", err.message);
    sock.sendMessage(from, { text: '❌ Erro ao criar figurinha.' });
  }
}

// ==== Extras ================================================================
const respostasCariocas = [
  "🚨 Qual foi? Tá de caô comigo não, né?",
  "👀 Ih, me marca não... cuidado que o Dobby é cria!",
  "🔥 Fala comigo! O que tu quer?",
  "😂 Tá viajando na maionese?",
  "🫡 Respeita o Dobby, cria de Madureira!",
  "😎 Ihh... tu tá querendo arrumar caô, é?",
  "💥 Fala tu! Qual é a boa?",
  "Não tem mais o que fazer, não?",
  "Agora eu não posso, estou trabalhando.",
];
const frasesSaida = [
  "😢 Que coisa feia, saiu... são 10 anos sem sexo agora!",
  "🚪 Porta da rua é serventia da casa... mas vai fazer falta, será? 👋",
  "👻 Saiu de fininho igual gasparzinho!",
  "🫠 Abandonou a gente... fraquejou, fraquejou!",
  "😂 Quem sai do grupo perde 50% do tesão automaticamente!",
];
const saiuRecentemente = new Set();
const ultimoPrivado = {}; // { userId: 'YYYY-MM-DD' }

// ==== Bot ====================================================================
async function startDobby() {
  const { state, saveCreds } = await useMultiFileAuthState('dobby_auth');
  const sock = makeWASocket({ auth: state }); // sem printQRInTerminal (deprecated)

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('📱 Escaneie o QR abaixo:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.message;
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

  const MENU_TXT = [
    '🧙‍♂️ **Dobby Menu**',
    '━━━━━━━━━━━━━━',
    '🎧 .tocar <artista - nome da música> — baixa e toca música direto do YouTube\n',
    '🖼️ .figura — transforma imagem/reply em figurinha\n',
    '🌞 .bomdia | .boatarde | .boanoite | .boamadrugada — frases estilo Mabel\n',
    '📅 .eventos — agenda do rolê\n',
    '📣 .todos [mensagem que quer mandar] — menciona geral (grupos, SÓ ADM)\n',
    '🎂 .niver DD/MM — cadastra seu aniversário\n',
    '🎂 .meuniver — consulta seu aniversário salvo\n',
  ].join('\n');

  // Comandos
  sock.ev.on('messages.upsert', async (ev) => {
    const m = ev.messages?.[0];
    if (!m || !m.message || m.key.fromMe) return;

    const from = m.key.remoteJid;
    const text = m.message?.conversation || m.message?.extendedTextMessage?.text || m.message?.imageMessage?.caption || '';
    const cmd = text.trim().toLowerCase();

    // 🔒 Privado (só uma vez por dia)
    if (!from.endsWith("@g.us")) {
      const user = from;
      const hoje = new Date().toISOString().slice(0,10);
      if (ultimoPrivado[user] !== hoje) {
        ultimoPrivado[user] = hoje;
        await sock.sendMessage(from, {
          text: "⚡ E aí, veio fuçar a vida do Dobby? Vou logo avisando que meu criador(a) não deixa eu abrir o bico 🤐. Agora, se tu quiser dar uma sugestão braba, manda aí que depois eu vejo... mas na moral, não enche que hoje eu tô na folga 😴🍻"
        });
      }
      return;
    }

    try {
      if (cmd === '.menu') return sock.sendMessage(from,{ text: MENU_TXT });

      if (['.bomdia', '.boatarde', '.boanoite', '.boamadrugada'].includes(cmd)) {
        const frase = await pegarFraseZen();
        return sock.sendMessage(from,{ text: frase });
      }

      if (cmd.startsWith('.tocar ')) {
        try {
          const query = text.slice(7).trim();
          const { buffer, title } = await baixarPorBusca(query);
          await sock.sendMessage(from,{ audio: buffer, mimetype: 'audio/mpeg' });
          await sock.sendMessage(from,{ text: `🎧 ${title}` });
        } catch (err) {
          console.error("Erro no .tocar:", err.message);
          sock.sendMessage(from,{ text:'❌ Erro ao tocar (pode ser vídeo muito longo, bloqueado ou ffmpeg/yt-dlp fora do PATH). Tenta outro nome/título.' });
        }
      }

      if (cmd === '.figura') return criarFigurinha(sock, m, from);

      if (cmd === '.eventos') {
        const eventos = [
          '📅 **Agenda da semana**',
          '━━━━━━━━━━━━━━',
          '💪 Segunda: Começar no gás!\n',
          '😎 Quinta: Quintas Intenções — quase sexta!\n',
          '🍻 Sexta: Happy Hour + Divulga aí seu trampo!\n',
          '🌳 Sábado & Domingo: 16h - DECK MADUREIRA - Rua Soares Caldeira, ao lado do shopping de Madureira!\n',
        ].join('\n');
        return sock.sendMessage(from, { text: eventos });
      }

      if (cmd.startsWith('.todos')) {
        try {
          const metadata = await sock.groupMetadata(from);
          const participants = metadata.participants.map((p) => p.id);
          const mensagem = text.replace('.todos', '').trim() || '📢 Bora todo mundo ouvir o Dobby!';
          await sock.sendMessage(from, { text: mensagem, mentions: participants });
        } catch { await sock.sendMessage(from, { text: '❌ Esse comando só funciona em grupos.' }); }
      }

      if (cmd.startsWith('.niver ')) {
        const partes = text.split(" ");
        let alvo = m.key.participant || m.key.remoteJid;
        let data;
        const metadata = await sock.groupMetadata(from);
        const isAdmin = metadata.participants.find(p=>p.id===m.key.participant && (p.admin==='admin'||p.admin==='superadmin'));
        if (partes.length === 3 && partes[1].startsWith('@')) {
          if (!isAdmin) return sock.sendMessage(from,{ text:"❌ Só admin pode cadastrar aniversário de outros" });
          alvo = partes[1].replace('@','') + "@s.whatsapp.net";
          data = partes[2];
        } else {
          data = partes[1];
        }
        if (!/^\d{2}\/\d{2}$/.test(data)) return sock.sendMessage(from,{ text:"❌ Formato inválido. Use `.niver 25/12`" });
        const nivers = carregarNivers(); nivers[alvo] = data; salvarNivers(nivers);
        return sock.sendMessage(from,{ text:`🎉 Aniversário de ${alvo} salvo: ${data}` });
      }

      if (cmd === '.meuniver') {
        const user = m.key.participant || m.key.remoteJid;
        const nivers = carregarNivers();
        return sock.sendMessage(from,{ text: nivers[user] ? `🎂 Seu aniversário: ${nivers[user]}` : "❌ Você não cadastrou. Use `.niver DD/MM`" });
      }

      // Carioca bolado (se marcar o Dobby no grupo)
      const mentions = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
      if (mentions.some(jid => jid.includes(sock.user.id.split(':')[0]))) {
        const resp = respostasCariocas[Math.floor(Math.random()*respostasCariocas.length)];
        await sock.sendMessage(from,{ text: resp });
      }

    } catch (e) { console.error('Erro geral:', e?.message || e); }
  });

  // Entrada/saída
  sock.ev.on("group-participants.update", async (update) => {
    for (const participant of update.participants) {
      const nome = `@${participant.split("@")[0]}`;
      if (update.action === "add") {
        if (saiuRecentemente.has(participant)) {
          await sock.sendMessage(update.id,{ text:`👊 E aê ${nome}, voltou pro melhor grupo do Errejota! 😎🍻`, mentions:[participant] });
          saiuRecentemente.delete(participant);
        } else {
          await sock.sendMessage(update.id,{ text:`👋 Bem-vindo @${participant.split('@')[0]} ao grupo *${(await sock.groupMetadata(update.id)).subject}*! 🎉`, mentions:[participant] });
        }
      } else if (update.action === "remove") {
        saiuRecentemente.add(participant);
        setTimeout(()=>saiuRecentemente.delete(participant),24*60*60*1000);
        const frase = frasesSaida[Math.floor(Math.random() * frasesSaida.length)];
        await sock.sendMessage(update.id,{ text: `${frase} ${nome}`, mentions:[participant] });
      }
    }
  });

  // Cron de parabéns
  cron.schedule("0 9 * * *", async () => {
    const hoje = new Date().toLocaleDateString("pt-BR",{day:"2-digit",month:"2-digit"});
    const nivers = carregarNivers();
    for (const [user,data] of Object.entries(nivers)) {
      if (data === hoje) {
        const grupos = await sock.groupFetchAllParticipating();
        for (const jid of Object.keys(grupos)) {
          await sock.sendMessage(jid,{ text:`🎉 Hoje é aniversário de @${user.split("@")[0]} 🎂 Parabéns Firezete! 🥳🔥🍻`, mentions:[user] });
        }
      }
    }
  });
}

startDobby();
