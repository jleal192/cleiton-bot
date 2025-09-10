Boa! 🚀
Segue um **README maneiro** pro teu projeto **Dobby Bot**, no estilo de GitHub, com explicação clara, badges e exemplos de uso:

---

# 🧙‍♂️ Dobby Bot — WhatsApp Bot

Dobby Bot é um bot estiloso e malandro pro **WhatsApp**, feito com **Baileys + Node.js + yt-dlp + ffmpeg**.
Ele responde mensagens, cria figurinhas, toca músicas, manda frases motivacionais em português 🇧🇷 e ainda solta aquelas respostas **cariocas boladas** quando é chamado no grupo.

![Node.js](https://img.shields.io/badge/Node.js-18%2B-green?logo=node.js)
![WhatsApp](https://img.shields.io/badge/WhatsApp-Bot-25D366?logo=whatsapp)
![License](https://img.shields.io/badge/license-MIT-blue)

---

## ✨ Funcionalidades

* 🎧 **.tocar** `<música/artista>` → baixa música do YouTube (via yt-dlp + ffmpeg)
* 🖼️ **.figura** → transforma imagem ou reply em figurinha
* 🌞 **.bomdia | .boatarde | .boanoite | .boamadrugada** → manda frases motivacionais em **português**
* 📅 **.eventos** → agenda de rolês estilosa
* 📣 **.todos** `[mensagem]` → menciona geral no grupo
* 🎂 **.niver DD/MM** → cadastra aniversário do usuário
* 🎂 **.meuniver** → consulta aniversário salvo
* 🤬 **Carioca bolado** → se marcar o Dobby no grupo, ele responde com frases no estilo carioca
* 👋 **Boas-vindas automáticas** para novos membros
* 😢 **Mensagens engraçadas de saída** quando alguém sai do grupo
* 🔒 **Privado (só 1x por dia)** → responde engraçado caso mandem msg direta

---

## 📦 Instalação

### Pré-requisitos

* [Node.js 18+](https://nodejs.org/)
* [FFmpeg](https://ffmpeg.org/download.html)
* [yt-dlp](https://github.com/yt-dlp/yt-dlp)

### Clone o projeto

```bash
git clone https://github.com/seuuser/dobby-bot.git
cd dobby-bot
```

### Instale dependências

```bash
npm install
```

### Configure

* Na primeira vez que rodar, será necessário escanear o **QR Code** com o WhatsApp.

### Execute

```bash
node dobby.js
```

---

## 📖 Exemplos de Uso

**No grupo:**

```
.tocar legião urbana tempo perdido
.figura (enviando imagem)
.todos Bora pro rolê hoje?
.niver 25/12
```

**Mensagem direta (1x por dia):**

```
[Você]: oi dobby
[Dobby]: ⚡ E aí, veio fuçar a vida do Dobby? Vou logo avisando que meu criador(a) não deixa eu abrir o bico 🤐. Agora, se tu quiser dar uma sugestão braba, manda aí que depois eu vejo... mas na moral, não enche que hoje eu tô na folga 😴🍻
```

---

## 🛠️ Tecnologias

* [Baileys](https://github.com/WhiskeySockets/Baileys) → Conexão com WhatsApp Web
* [yt-dlp](https://github.com/yt-dlp/yt-dlp) → Download de músicas
* [ffmpeg](https://ffmpeg.org/) → Conversão de áudio
* [sharp](https://sharp.pixelplumbing.com/) → Manipulação de imagens (figurinhas)
* [node-cron](https://www.npmjs.com/package/node-cron) → Agendamento de tarefas (parabéns automáticos)

---

## ⚠️ Aviso

Este projeto é apenas para **fins educacionais**.
Não me responsabilizo pelo uso indevido do bot.

---

## 📜 Licença

[MIT](LICENSE) — pode usar, modificar e compartilhar à vontade.
