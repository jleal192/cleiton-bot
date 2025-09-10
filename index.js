// Dobby Bot — versão yt-dlp + ffmpeg (sem play-dl / ytdl-core)
// Stack: Baileys + yt-dlp + ffmpeg + sharp + node-cron
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

    // Traduz via API MyMemory
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

// Baixar áudio de um URL do YouTube
async function baixarAudioMP3(url, maxDurationSec = 150, targetBitrate = '128k') {
  const outFile = tempFile('.mp3');
  return new Promise((resolve, reject) => {
    const ytdlp = spawn('yt-dlp', ['-f','bestaudio','-o','-', url]);
    const ffmpegProc = spawn('ffmpeg', [
      '-i','pipe:0','-t',String(maxDurationSec),
      '-vn','-ac','2','-ar','44100','-b:a',targetBitrate,
      '-f','mp3',outFile,
    ]);
    ytdlp.stdout.pipe(ffmpegProc.stdin);
    ffmpegProc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg falhou`));
      try {
        const buf = fs.readFileSync(outFile);
        fs.unlink(outFile, () => {});
        resolve(buf);
      } catch (err) { reject(err); }
    });
  });
}

// Buscar no YouTube e tentar baixar
async function baixarPorBusca(query, tentativaDurSeg = [150, 120, 90]) {
  const result = await ytSearch(query);
  const vids = (result && result.videos) || [];
  if (!vids.length) throw new Error('Nenhum vídeo encontrado');

  for (let v of vids.slice(0, 5)) {
    for (const dur of tentativaDurSeg) {
      try {
        const buf = await baixarAudioMP3(v.url, dur, '128k');
        if (buf) return { buffer: buf, title: v.title };
      } catch {}
    }
  }
  throw new Error("Falha ao baixar");
}

// Criar figurinha
async function criarFigurinha(sock, m, from) {
  let buffer;

  if (m.message?.imageMessage) {
    const stream = await downloadContentFromMessage(m.message.imageMessage,'image');
    buffer = Buffer.concat([]);
    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
  }
  if (!buffer && m.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage) {
    const quoted = m.message.extendedTextMessage.contextInfo.quotedMessage.imageMessage;
    const stream = await downloadContentFromMessage(quoted,'image');
    buffer = Buffer.concat([]);
    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
  }
  if (!buffer) return sock.sendMessage(from, { text: '❌ Nenhuma imagem encontrada 😅' });
  const webpBuffer = await sharp(buffer).webp({ quality: 90 }).toBuffer();
  await sock.sendMessage(from, { sticker: webpBuffer });
  await sock.sendMessage(from, { text: '🪄 Figurinha criada!' });
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
];
const frasesSaida = [
  "😢 Que coisa feia, saiu... são 10 anos sem sexo agora!",
  "🚪 Porta da rua é serventia da casa... mas vai fazer falta 👋",
  "👻 Saiu de fininho igual gasparzinho!",
  "🫠 Abandonou a gente... fraquejou, fraquejou!",
  "😂 Quem sai do grupo perde 50% do tesão automaticamente!",
];
const saiuRecentemente = new Set();
const ultimoPrivado = {}; // { userId: 'YYYY-MM-DD' }

// ==== Bot ====================================================================
async function startDobby() {
  const { state, saveCreds } = await useMultiFileAuthState('dobby_auth');
  const sock = makeWASocket({ auth: state, printQRInTerminal: true });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
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
    '🎧 .tocar <música/artista> — NÃO FUNCIONA (EM BREVE)',
    '🖼️ .figura — transforma imagem/reply em figurinha',
    '🌞 .bomdia | .boatarde | .boanoite | .boamadrugada — frases estilo Mabel',
    '📅 .eventos — agenda do rolê',
    '📣 .todos [mensagem que quer mandar] — menciona geral (grupos)',
    '🎂 .niver DD/MM — cadastra seu aniversário',
    '🎂 .meuniver — consulta seu aniversário salvo',
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
  const user = m.key.participant || m.key.remoteJid; 
  const tag = user.split('@')[0]; 

  return sock.sendMessage(from, { 
    text: `@${tag} ${frase} 💪`, 
    mentions: [user] 
  });
}

      if (cmd.startsWith('.tocar ')) {
        try {
          const query = text.slice(7).trim();
          const { buffer, title } = await baixarPorBusca(query);
          await sock.sendMessage(from,{ audio: buffer, mimetype: 'audio/mpeg' });
          await sock.sendMessage(from,{ text: `🎧 ${title}` });
        } catch { sock.sendMessage(from,{ text:'❌ Erro ao tocar' }); }
      }

      if (cmd === '.figura') return criarFigurinha(sock, m, from);

      if (cmd === '.eventos') {
        const eventos = [
          '📅 **Agenda do rolê**',
          '━━━━━━━━━━━━━━',
          '💪 Segunda: Começar no gás!\n',
          '😎 Quinta: Quintas Intenções — quase sexta!\n',
          '🍻 Sexta: Happy Hour + Divulga seu trampo!\n',
          '🌳 Sábado & Domingo: Encontrão no Parque de Madureira, se tu não for, só você não vai!\n',
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
