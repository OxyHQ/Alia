# ActivityPub Server - @alia@alia.onl

Servidor ActivityPub completo para que Alia funcione en el Fediverso (Mastodon, Pleroma, etc.).

## 🚀 Setup

### 1. Generar Claves RSA (una sola vez)

```bash
cd apps/api
npm run generate-keys
```

### 2. Variables de Entorno

**DigitalOcean App Platform → API service**:
```env
ACTIVITYPUB_DOMAIN=alia.onl
ACTOR_DOMAIN=api.alia.onl
```

### 3. Deploy

Push a Git → DigitalOcean auto-deploya.

## 🧪 Testing

```bash
# WebFinger (desde alia.onl)
curl https://alia.onl/.well-known/webfinger?resource=acct:alia@alia.onl

# Actor (desde api.alia.onl)
curl -H "Accept: application/activity+json" https://api.alia.onl/actors/alia

# Desde Mastodon
Buscar: @alia@alia.onl
```

## 📁 Implementación

### API Server (apps/api/)
- `src/lib/activitypub/` - Core (config, signatures, fetcher, sender, processor, utils)
- `src/routes/activitypub/` - Endpoints (actor, inbox, outbox, followers)
- `src/models/activitypub-*.ts` - MongoDB models
- `src/scripts/generate-activitypub-keys.ts` - Script de claves

### App Expo (apps/app/)
- `app/api/.well-known/webfinger/+api.ts` - WebFinger API route
- `public/.well-known/webfinger` - Fallback estático

## 🔧 Cómo Funciona

```
Usuario menciona @alia@alia.onl
    ↓
WebFinger lookup en alia.onl
    ↓
Fetch actor de api.alia.onl
    ↓
POST firmado a inbox
    ↓
Procesar + IA (alia-lite)
    ↓
Responder al usuario
```

## 🐛 Troubleshooting

| Problema | Solución |
|----------|----------|
| No encuentra @alia | Verifica WebFinger en alia.onl |
| Invalid signature | Regenera claves RSA |
| No responde | Revisa logs en DO, verifica MongoDB |

## ✅ Checklist

- [ ] Claves RSA generadas
- [ ] Variables en DO configuradas
- [ ] WebFinger funciona
- [ ] Actor retorna JSON
- [ ] Búsqueda en Mastodon funciona
- [ ] Responde a menciones

**Handle**: `@alia@alia.onl`
**Modelo**: alia-lite
**Límite**: 480 chars
