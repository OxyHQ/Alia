import { tool } from "ai";
import { z } from "zod";

export interface DeviceInfo {
  deviceName?: string | null;
  modelName?: string | null;
  osName?: string | null;
  osVersion?: string | null;
  platformOS?: string;
  brand?: string | null;
  manufacturer?: string | null;
  designName?: string | null;
  deviceYearClass?: number | null;
  totalMemory?: number | null;
}

/**
 * Tool to retrieve device information
 * Only includes device data when the AI explicitly requests it
 */
export const createGetDeviceInfoTool = (deviceInfo: DeviceInfo | null) => tool({
  description: `Obtiene información sobre el dispositivo del usuario.

CUÁNDO USAR: Úsala cuando el usuario haga preguntas relacionadas con:
- Su dispositivo móvil o teléfono
- Problemas técnicos que requieran conocer las especificaciones del dispositivo
- Compatibilidad de apps o características con su dispositivo
- Consultas sobre su sistema operativo, modelo de teléfono, o RAM

EJEMPLOS de cuándo usar:
- "¿Qué teléfono tengo?"
- "¿Cuánta RAM tiene mi dispositivo?"
- "¿Mi teléfono es compatible con...?"
- "¿Qué versión de Android/iOS tengo?"

NO USAR para preguntas generales que no requieran información del dispositivo.`,

  inputSchema: z.object({}),

  execute: async () => {
    if (!deviceInfo) {
      return {
        success: false,
        message: "No se pudo obtener información del dispositivo. Esto puede ocurrir si el usuario está usando la versión web de la aplicación."
      };
    }

    // Format device info in a readable way
    const info: any = {
      success: true,
      message: "Información del dispositivo obtenida exitosamente"
    };

    if (deviceInfo.deviceName) {
      info.deviceName = deviceInfo.deviceName;
    }

    if (deviceInfo.manufacturer && deviceInfo.modelName) {
      info.model = `${deviceInfo.manufacturer} ${deviceInfo.modelName}`;
    } else if (deviceInfo.modelName) {
      info.model = deviceInfo.modelName;
    }

    if (deviceInfo.brand) {
      info.brand = deviceInfo.brand;
    }

    if (deviceInfo.osName && deviceInfo.osVersion) {
      info.operatingSystem = `${deviceInfo.osName} ${deviceInfo.osVersion}`;
    }

    if (deviceInfo.platformOS) {
      info.platform = deviceInfo.platformOS;
    }

    if (deviceInfo.totalMemory) {
      const memoryGB = (deviceInfo.totalMemory / (1024 * 1024 * 1024)).toFixed(2);
      info.ram = `${memoryGB} GB`;
    }

    if (deviceInfo.deviceYearClass) {
      info.deviceYear = deviceInfo.deviceYearClass;
    }

    return info;
  },
});
