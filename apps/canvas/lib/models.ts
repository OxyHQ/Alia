export interface Model {
  id: string;
  name: string;
  description: string;
}

export const MODELS: Model[] = [
  {
    id: "alia-v1-lite",
    name: "Alia V1 Lite",
    description: "Lightweight and blazing fast"
  },
  {
    id: "alia-v1",
    name: "Alia V1",
    description: "Fast and efficient model"
  },
  {
    id: "alia-v1-codea",
    name: "Alia V1 Codea",
    description: "Optimized for code generation"
  },
  {
    id: "alia-v1-pro",
    name: "Alia V1 Pro",
    description: "Enhanced reasoning and accuracy"
  },
  {
    id: "alia-v1-pro-max",
    name: "Alia V1 Pro Max",
    description: "Maximum performance and capabilities"
  },
];
