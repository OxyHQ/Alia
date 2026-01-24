# WebFinger Setup para @alia@alia.onl

## ✅ Implementado

Se han creado dos archivos para servir el endpoint WebFinger:

### 1. API Route (Recomendado)
**Archivo**: `app/api/.well-known/webfinger/+api.ts`

- Responde dinámicamente a requests
- Soporta query parameters
- Valida el recurso solicitado
- Headers CORS correctos

### 2. Archivo Estático (Fallback)
**Archivo**: `public/.well-known/webfinger`

- Archivo JSON estático
- Fallback si el API route falla
- Funciona en cualquier hosting

## 🧪 Testing Local

1. **Iniciar servidor de desarrollo**:
```bash
npm run dev
# o
npm start
```

2. **Test API route**:
```bash
curl http://localhost:8081/.well-known/webfinger?resource=acct:alia@alia.onl
```

3. **Test archivo estático**:
```bash
curl http://localhost:8081/.well-known/webfinger
```

Ambos deberían devolver:
```json
{
  "subject": "acct:alia@alia.onl",
  "aliases": ["https://api.alia.onl/actors/alia"],
  "links": [{
    "rel": "self",
    "type": "application/activity+json",
    "href": "https://api.alia.onl/actors/alia"
  }]
}
```

## 🚀 Deploy

### DigitalOcean App Platform

1. El archivo `public/.well-known/webfinger` se copiará automáticamente al build
2. El API route en `app/api/.well-known/webfinger/+api.ts` se compilará

No necesitas configuración adicional.

### Vercel / Netlify

Si usas estos servicios, ambos archivos funcionarán automáticamente.

## 🔍 Verificación en Producción

Después de deployar a `https://alia.onl`:

```bash
# Test WebFinger
curl https://alia.onl/.well-known/webfinger?resource=acct:alia@alia.onl

# Debe devolver JSON con link a api.alia.onl
```

## 🐛 Troubleshooting

### Error 404 en /.well-known/webfinger

1. Verifica que el build incluyó los archivos:
   - Busca `webfinger` en la carpeta `dist/`
   - Verifica que `public/.well-known/webfinger` existe

2. Revisa los logs del servidor para ver qué ruta se está intentando acceder

3. Si el API route no funciona, asegúrate de que el archivo estático esté siendo servido

### Content-Type incorrecto

El archivo debe servirse con `Content-Type: application/jrd+json`. El API route lo configura automáticamente, pero si usas el archivo estático, podrías necesitar configurar el servidor.

Para DigitalOcean App Platform, generalmente no es necesario configurar nada.

## 📝 Notas

- El endpoint responde a cualquier query parameter `resource`
- Solo reconoce `acct:alia@alia.onl` y variaciones
- CORS está habilitado (`Access-Control-Allow-Origin: *`)
- Cache configurado a 1 hora (`Cache-Control: public, max-age=3600`)

## ✨ ¿Cómo Funciona?

1. Usuario busca `@alia@alia.onl` en Mastodon
2. Mastodon hace request a `https://alia.onl/.well-known/webfinger?resource=acct:alia@alia.onl`
3. Tu app responde con el JSON apuntando a `https://api.alia.onl/actors/alia`
4. Mastodon fetch del actor en api.alia.onl
5. ✅ Usuario puede seguir y mencionar a Alia

## 🔗 Archivos Relacionados

- `app/api/.well-known/webfinger/+api.ts` - API route
- `public/.well-known/webfinger` - Archivo estático
- `../../ACTIVITYPUB_IMPLEMENTATION_SUMMARY.md` - Documentación completa
