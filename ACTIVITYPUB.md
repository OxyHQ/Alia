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

Choose one option:

**Simple setup (recommended to start)**:
```env
ACTIVITYPUB_DOMAIN=api.alia.onl
ACTOR_DOMAIN=api.alia.onl
```

**Custom domain (requires proxy/redirect)**:
```env
ACTIVITYPUB_DOMAIN=alia.onl
ACTOR_DOMAIN=api.alia.onl
```

### 3. Deploy

Push a Git → DigitalOcean auto-deploya.

## 🌐 DigitalOcean Configuration

You have 3 options to make WebFinger work:

### Option A: Use api.alia.onl as the handle (SIMPLEST - No redirect needed!)
Set environment variables in the API service:
```env
ACTIVITYPUB_DOMAIN=api.alia.onl
ACTOR_DOMAIN=api.alia.onl
```
**Handle becomes**: `@alia@api.alia.onl`
✅ No redirect configuration needed
✅ Works immediately after deploy
❌ Less clean domain (shows "api" subdomain)

### Option B: Use Cloudflare or nginx proxy
If you use Cloudflare or have nginx in front:
```nginx
location /.well-known/webfinger {
    proxy_pass https://api.alia.onl/.well-known/webfinger$is_args$args;
}
```

### Option C: Point alia.onl DNS to API server
Change your DNS records so `alia.onl` points to the API server instead of the Expo app.
**Note**: This means your Expo app would need to be on a different domain like `app.alia.onl`.

## 🧪 Testing

```bash
# WebFinger (MUST work from alia.onl)
curl "https://alia.onl/.well-known/webfinger?resource=acct:alia@alia.onl"

# WebFinger (direct from API)
curl "https://api.alia.onl/.well-known/webfinger?resource=acct:alia@alia.onl"

# Actor (desde api.alia.onl)
curl -H "Accept: application/activity+json" https://api.alia.onl/actors/alia

# Health check
curl https://api.alia.onl/activitypub/health

# Desde Mastodon
Buscar: @alia@alia.onl
```

## 📁 Implementación

### API Server (apps/api/)
- `src/lib/activitypub/` - Core (config, signatures, fetcher, sender, processor, utils)
- `src/routes/activitypub/` - Endpoints (webfinger, actor, inbox, outbox, followers)
- `src/models/activitypub-*.ts` - MongoDB models
- `src/scripts/generate-activitypub-keys.ts` - Script de claves

**Nota**: WebFinger está en el API server porque la app Expo usa `output: "static"` y no puede ejecutar API routes.

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
| No encuentra @alia@alia.onl | **CRÍTICO**: WebFinger DEBE funcionar en `https://alia.onl/.well-known/webfinger`. Configura redirect en DO o mueve DNS a API server |
| 404 en WebFinger | Verifica que el redirect de DO esté configurado correctamente |
| Invalid signature | Regenera claves RSA con `npm run generate-keys` |
| No responde a menciones | Revisa logs en DO, verifica MongoDB, confirma que inbox esté recibiendo requests |
| Expo app es static | ✅ Correcto - WebFinger ahora está en API server |

## ✅ Checklist

- [ ] Claves RSA generadas (`npm run generate-keys` en apps/api)
- [ ] Variables en DO configuradas (ACTIVITYPUB_DOMAIN, ACTOR_DOMAIN)
- [ ] **CRÍTICO**: Redirect configurado en DO (alia.onl → api.alia.onl para /.well-known/webfinger)
- [ ] WebFinger funciona en `https://alia.onl/.well-known/webfinger?resource=acct:alia@alia.onl`
- [ ] WebFinger funciona en `https://api.alia.onl/.well-known/webfinger?resource=acct:alia@alia.onl`
- [ ] Actor retorna JSON en `https://api.alia.onl/actors/alia`
- [ ] Búsqueda en Mastodon funciona (@alia@alia.onl)
- [ ] Responde a menciones

**Handle**: `@alia@alia.onl`
**Modelo**: alia-lite
**Límite**: 480 chars
