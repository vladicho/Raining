# Raining

Mapa meteorológico gratuito e bilíngue para **Rurrenabaque, Bolívia**.

## Recursos

- condições atuais e previsão de 7 dias via Open-Meteo;
- mapa centralizado em Rurrenabaque;
- imagem diária de satélite da NASA GIBS;
- animação das últimas duas horas de radar via RainViewer;
- interface em português e espanhol;
- layout otimizado para celular;
- sem backend, banco de dados ou chave de API.
- webhook seguro para responder a previsão pelo WhatsApp Cloud API.

## Executar

Abra `src/index.html` por um servidor HTTP local ou execute:

```bash
npm run build
npx serve dist
```

## Cloudflare Pages

- Comando de build: `npm run build`
- Diretório de saída: `dist`
- Branch de produção: `main`

## WhatsApp Cloud API

O Worker expõe:

- `GET /webhook` para a verificação da Meta;
- `POST /webhook` para receber mensagens assinadas;
- `GET /api/weather` para os dados meteorológicos em JSON;
- `GET /api/health` para verificação simples do serviço.

Cadastre estes valores como **Secrets** no Worker, nunca no GitHub:

- `WHATSAPP_VERIFY_TOKEN`
- `META_APP_SECRET`
- `WHATSAPP_ACCESS_TOKEN`
- `WHATSAPP_PHONE_NUMBER_ID`

URL de callback: `https://raining.lugarerrado.com/webhook`

## Fontes

Open-Meteo, NASA GIBS, RainViewer, OpenStreetMap e Esri. As atribuições também aparecem no mapa.
