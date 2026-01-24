/**
 * Componente para insertar Structured Data (JSON-LD) en páginas
 * Uso: <StructuredData data={schema} />
 */

interface StructuredDataProps {
  data: object | object[];
}

export function StructuredData({ data }: StructuredDataProps) {
  const schemas = Array.isArray(data) ? data : [data];

  return (
    <>
      {schemas.map((schema, index) => {
        const jsonString = JSON.stringify(schema);
        // Para web, usar dangerouslySetInnerHTML correctamente
        // @ts-ignore - Expo Router maneja esto en web
        return (
          <script
            key={index}
            type="application/ld+json"
            dangerouslySetInnerHTML={{ __html: jsonString }}
          />
        );
      })}
    </>
  );
}
