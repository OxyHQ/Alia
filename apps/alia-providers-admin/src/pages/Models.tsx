import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxyhq/auth';
import { apiClient } from '@/lib/api/client';
import { useRealtimeModels } from '@/lib/websocket/hooks';
import { ALIA_TIERS, PROVIDERS } from '@/types';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import {
  Plus,
  MoreVertical,
  Edit,
  Trash2,
  AlertTriangle,
  X,
} from 'lucide-react';
import type { ModelConfig, AliaModel } from '@/types';

export function ModelsPage() {
  const [activeTab, setActiveTab] = useState('provider-models');
  const [isAddProviderModelOpen, setIsAddProviderModelOpen] = useState(false);
  const [isEditProviderModelOpen, setIsEditProviderModelOpen] = useState(false);
  const [isDeleteProviderModelOpen, setIsDeleteProviderModelOpen] = useState(false);
  const [selectedProviderModel, setSelectedProviderModel] = useState<ModelConfig | null>(null);

  // Alia model dialog states
  const [isAddAliaModelOpen, setIsAddAliaModelOpen] = useState(false);
  const [isEditAliaModelOpen, setIsEditAliaModelOpen] = useState(false);
  const [isDeleteAliaModelOpen, setIsDeleteAliaModelOpen] = useState(false);
  const [selectedAliaModel, setSelectedAliaModel] = useState<AliaModel | null>(null);

  const defaultAliaModelForm = {
    aliasModelId: '',
    displayName: '',
    tier: 'v1' as string,
    description: '',
    creditMultiplier: 1.0,
    isFreeTier: true,
    providerMappings: [] as Array<{
      provider: string;
      modelId: string;
      priority: number;
      qualityScore: number;
      isActive: boolean;
    }>,
  };
  const [aliaModelForm, setAliaModelForm] = useState(defaultAliaModelForm);

  const [providerModelForm, setProviderModelForm] = useState({
    provider: 'openai',
    modelId: '',
    displayName: '',
    pricing: {
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
    },
    capabilities: {
      maxInputTokens: 128000,
      maxOutputTokens: 16384,
      supportsStreaming: true,
      supportsTools: false,
      supportsVision: false,
      supportsJsonMode: false,
      supportsPdf: false,
      urlContext: false,
      thinkingLevel: 'NONE' as 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH',
    },
  });

  const { isAuthenticated } = useAuth();
  const queryClient = useQueryClient();

  // Real-time data subscriptions
  const { data: realtimeProviderModelsData, isConnected: providerModelsConnected } = useRealtimeModels();

  // Fallback to polling if WebSocket is not connected
  const { data: polledProviderModelsData, isLoading: providerModelsLoading } = useQuery({
    queryKey: ['provider-models'],
    queryFn: () => apiClient.listModels(),
    refetchInterval: providerModelsConnected ? false : 60000,
    enabled: isAuthenticated && !providerModelsConnected,
  });

  const { data: polledAliaModelsData, isLoading: aliaModelsLoading } = useQuery({
    queryKey: ['alia-models'],
    queryFn: () => apiClient.listAliaModels(),
    refetchInterval: 60000,
    enabled: isAuthenticated,
  });

  // Use real-time data if available, otherwise fall back to polled data
  const providerModelsData = realtimeProviderModelsData || polledProviderModelsData;

  const providerModels: ModelConfig[] = (providerModelsData as any)?.data || [];
  const aliaModels: AliaModel[] = (polledAliaModelsData as any)?.data || [];

  // Create provider model mutation
  const createProviderModelMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) => apiClient.createModel(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['provider-models'] });
      setIsAddProviderModelOpen(false);
      resetProviderModelForm();
    },
  });

  // Update provider model mutation
  const updateProviderModelMutation = useMutation({
    mutationFn: ({ provider, modelId, data }: { provider: string; modelId: string; data: Record<string, unknown> }) =>
      apiClient.updateModel(provider, modelId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['provider-models'] });
      setIsEditProviderModelOpen(false);
      setSelectedProviderModel(null);
    },
  });

  // Delete provider model mutation
  const deleteProviderModelMutation = useMutation({
    mutationFn: ({ provider, modelId }: { provider: string; modelId: string }) =>
      apiClient.deleteModel(provider, modelId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['provider-models'] });
      setIsDeleteProviderModelOpen(false);
      setSelectedProviderModel(null);
    },
  });

  // Alia model mutations
  const createAliaModelMutation = useMutation({
    mutationFn: (data: typeof defaultAliaModelForm) => apiClient.createAliaModel(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['alia-models'] });
      setIsAddAliaModelOpen(false);
      setAliaModelForm(defaultAliaModelForm);
    },
  });

  const updateAliaModelMutation = useMutation({
    mutationFn: ({ aliasModelId, data }: { aliasModelId: string; data: unknown }) =>
      apiClient.updateAliaModel(aliasModelId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['alia-models'] });
      setIsEditAliaModelOpen(false);
      setSelectedAliaModel(null);
    },
  });

  const deleteAliaModelMutation = useMutation({
    mutationFn: (aliasModelId: string) => apiClient.deleteAliaModel(aliasModelId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['alia-models'] });
      setIsDeleteAliaModelOpen(false);
      setSelectedAliaModel(null);
    },
  });

  const handleEditAliaModel = (model: AliaModel) => {
    setSelectedAliaModel(model);
    setAliaModelForm({
      aliasModelId: model.aliasModelId,
      displayName: model.displayName,
      tier: model.tier,
      description: model.description || '',
      creditMultiplier: model.creditMultiplier,
      isFreeTier: model.isFreeTier,
      providerMappings: model.providerMappings.map((m) => ({
        provider: m.provider,
        modelId: m.modelId,
        priority: m.priority,
        qualityScore: m.qualityScore,
        isActive: m.isActive,
      })),
    });
    setIsEditAliaModelOpen(true);
  };

  const handleDeleteAliaModel = (model: AliaModel) => {
    setSelectedAliaModel(model);
    setIsDeleteAliaModelOpen(true);
  };

  const handleAliaModelSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isEditAliaModelOpen && selectedAliaModel) {
      const { aliasModelId: _, ...data } = aliaModelForm;
      updateAliaModelMutation.mutate({
        aliasModelId: selectedAliaModel.aliasModelId,
        data,
      });
    } else {
      createAliaModelMutation.mutate(aliaModelForm);
    }
  };

  const addProviderMapping = () => {
    setAliaModelForm({
      ...aliaModelForm,
      providerMappings: [
        ...aliaModelForm.providerMappings,
        { provider: 'openai', modelId: '', priority: aliaModelForm.providerMappings.length + 1, qualityScore: 80, isActive: true },
      ],
    });
  };

  const removeProviderMapping = (index: number) => {
    setAliaModelForm({
      ...aliaModelForm,
      providerMappings: aliaModelForm.providerMappings.filter((_, i) => i !== index),
    });
  };

  const updateProviderMapping = (index: number, field: string, value: unknown) => {
    const updated = [...aliaModelForm.providerMappings];
    updated[index] = { ...updated[index], [field]: value };
    setAliaModelForm({ ...aliaModelForm, providerMappings: updated });
  };

  const resetProviderModelForm = () => {
    setProviderModelForm({
      provider: 'openai',
      modelId: '',
      displayName: '',
      pricing: {
        inputCostPerMillion: 0,
        outputCostPerMillion: 0,
      },
      capabilities: {
        maxInputTokens: 128000,
        maxOutputTokens: 16384,
        supportsStreaming: true,
        supportsTools: false,
        supportsVision: false,
        supportsJsonMode: false,
        supportsPdf: false,
        urlContext: false,
        thinkingLevel: 'NONE',
      },
    });
  };

  const handleEditProviderModel = (model: ModelConfig) => {
    setSelectedProviderModel(model);
    setProviderModelForm({
      provider: model.provider,
      modelId: model.modelId,
      displayName: model.displayName || '',
      pricing: model.pricing,
      capabilities: model.capabilities,
    });
    setIsEditProviderModelOpen(true);
  };

  const handleDeleteProviderModel = (model: ModelConfig) => {
    setSelectedProviderModel(model);
    setIsDeleteProviderModelOpen(true);
  };

  const handleProviderModelSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isEditProviderModelOpen && selectedProviderModel) {
      updateProviderModelMutation.mutate({
        provider: selectedProviderModel.provider,
        modelId: selectedProviderModel.modelId,
        data: {
          displayName: providerModelForm.displayName,
          pricing: providerModelForm.pricing,
          capabilities: providerModelForm.capabilities,
        },
      });
    } else {
      createProviderModelMutation.mutate(providerModelForm);
    }
  };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Models</h1>
        <p className="text-muted-foreground">
          Manage provider models and Alia virtual model configurations
        </p>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="provider-models">Provider Models</TabsTrigger>
          <TabsTrigger value="alia-models">Alia Models</TabsTrigger>
        </TabsList>

        {/* Provider Models Tab */}
        <TabsContent value="provider-models" className="space-y-4">
          <div className="flex justify-end">
            <Dialog open={isAddProviderModelOpen} onOpenChange={setIsAddProviderModelOpen}>
              <DialogTrigger asChild>
                <Button>
                  <Plus className="mr-2 h-4 w-4" />
                  Add Provider Model
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
                <form onSubmit={handleProviderModelSubmit}>
                  <DialogHeader>
                    <DialogTitle>Add Provider Model</DialogTitle>
                    <DialogDescription>
                      Add a new model configuration for a provider
                    </DialogDescription>
                  </DialogHeader>
                  <div className="grid gap-4 py-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div className="grid gap-2">
                        <Label htmlFor="provider">Provider</Label>
                        <Select
                          value={providerModelForm.provider}
                          onValueChange={(value) =>
                            setProviderModelForm({ ...providerModelForm, provider: value })
                          }
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {PROVIDERS.map((p) => (
                              <SelectItem key={p} value={p}>
                                {p.charAt(0).toUpperCase() + p.slice(1)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="grid gap-2">
                        <Label htmlFor="modelId">Model ID</Label>
                        <Input
                          id="modelId"
                          value={providerModelForm.modelId}
                          onChange={(e) =>
                            setProviderModelForm({ ...providerModelForm, modelId: e.target.value })
                          }
                          placeholder="gpt-4o"
                          required
                        />
                      </div>
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="displayName">Display Name</Label>
                      <Input
                        id="displayName"
                        value={providerModelForm.displayName}
                        onChange={(e) =>
                          setProviderModelForm({ ...providerModelForm, displayName: e.target.value })
                        }
                        placeholder="GPT-4o"
                      />
                    </div>

                    <Separator />
                    <h3 className="font-semibold">Pricing</h3>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="grid gap-2">
                        <Label htmlFor="inputCost">Input Cost (per million tokens)</Label>
                        <Input
                          id="inputCost"
                          type="number"
                          step="0.01"
                          value={providerModelForm.pricing.inputCostPerMillion}
                          onChange={(e) =>
                            setProviderModelForm({
                              ...providerModelForm,
                              pricing: {
                                ...providerModelForm.pricing,
                                inputCostPerMillion: parseFloat(e.target.value),
                              },
                            })
                          }
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label htmlFor="outputCost">Output Cost (per million tokens)</Label>
                        <Input
                          id="outputCost"
                          type="number"
                          step="0.01"
                          value={providerModelForm.pricing.outputCostPerMillion}
                          onChange={(e) =>
                            setProviderModelForm({
                              ...providerModelForm,
                              pricing: {
                                ...providerModelForm.pricing,
                                outputCostPerMillion: parseFloat(e.target.value),
                              },
                            })
                          }
                        />
                      </div>
                    </div>

                    <Separator />
                    <h3 className="font-semibold">Capabilities</h3>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="grid gap-2">
                        <Label htmlFor="maxInputTokens">Max Input Tokens</Label>
                        <Input
                          id="maxInputTokens"
                          type="number"
                          value={providerModelForm.capabilities.maxInputTokens}
                          onChange={(e) =>
                            setProviderModelForm({
                              ...providerModelForm,
                              capabilities: {
                                ...providerModelForm.capabilities,
                                maxInputTokens: parseInt(e.target.value),
                              },
                            })
                          }
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label htmlFor="maxOutputTokens">Max Output Tokens</Label>
                        <Input
                          id="maxOutputTokens"
                          type="number"
                          value={providerModelForm.capabilities.maxOutputTokens}
                          onChange={(e) =>
                            setProviderModelForm({
                              ...providerModelForm,
                              capabilities: {
                                ...providerModelForm.capabilities,
                                maxOutputTokens: parseInt(e.target.value),
                              },
                            })
                          }
                        />
                      </div>
                    </div>

                    <div className="grid gap-3">
                      <div className="flex items-center justify-between">
                        <Label htmlFor="supportsStreaming">Supports Streaming</Label>
                        <Switch
                          id="supportsStreaming"
                          checked={providerModelForm.capabilities.supportsStreaming}
                          onCheckedChange={(checked) =>
                            setProviderModelForm({
                              ...providerModelForm,
                              capabilities: {
                                ...providerModelForm.capabilities,
                                supportsStreaming: checked,
                              },
                            })
                          }
                        />
                      </div>
                      <div className="flex items-center justify-between">
                        <Label htmlFor="supportsTools">Supports Tools/Function Calling</Label>
                        <Switch
                          id="supportsTools"
                          checked={providerModelForm.capabilities.supportsTools}
                          onCheckedChange={(checked) =>
                            setProviderModelForm({
                              ...providerModelForm,
                              capabilities: {
                                ...providerModelForm.capabilities,
                                supportsTools: checked,
                              },
                            })
                          }
                        />
                      </div>
                      <div className="flex items-center justify-between">
                        <Label htmlFor="supportsVision">Supports Vision</Label>
                        <Switch
                          id="supportsVision"
                          checked={providerModelForm.capabilities.supportsVision}
                          onCheckedChange={(checked) =>
                            setProviderModelForm({
                              ...providerModelForm,
                              capabilities: {
                                ...providerModelForm.capabilities,
                                supportsVision: checked,
                              },
                            })
                          }
                        />
                      </div>
                      <div className="flex items-center justify-between">
                        <Label htmlFor="supportsJsonMode">Supports JSON Mode</Label>
                        <Switch
                          id="supportsJsonMode"
                          checked={providerModelForm.capabilities.supportsJsonMode}
                          onCheckedChange={(checked) =>
                            setProviderModelForm({
                              ...providerModelForm,
                              capabilities: {
                                ...providerModelForm.capabilities,
                                supportsJsonMode: checked,
                              },
                            })
                          }
                        />
                      </div>
                      <div className="flex items-center justify-between">
                        <Label htmlFor="supportsPdf">Supports PDF</Label>
                        <Switch
                          id="supportsPdf"
                          checked={providerModelForm.capabilities.supportsPdf}
                          onCheckedChange={(checked) =>
                            setProviderModelForm({
                              ...providerModelForm,
                              capabilities: {
                                ...providerModelForm.capabilities,
                                supportsPdf: checked,
                              },
                            })
                          }
                        />
                      </div>
                      <div className="flex items-center justify-between">
                        <Label htmlFor="urlContext">URL Context</Label>
                        <Switch
                          id="urlContext"
                          checked={providerModelForm.capabilities.urlContext}
                          onCheckedChange={(checked) =>
                            setProviderModelForm({
                              ...providerModelForm,
                              capabilities: {
                                ...providerModelForm.capabilities,
                                urlContext: checked,
                              },
                            })
                          }
                        />
                      </div>
                    </div>

                    <div className="grid gap-2">
                      <Label htmlFor="thinkingLevel">Thinking Level</Label>
                      <Select
                        value={providerModelForm.capabilities.thinkingLevel}
                        onValueChange={(value: string) =>
                          setProviderModelForm({
                            ...providerModelForm,
                            capabilities: {
                              ...providerModelForm.capabilities,
                              thinkingLevel: value as 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH',
                            },
                          })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="NONE">None</SelectItem>
                          <SelectItem value="LOW">Low</SelectItem>
                          <SelectItem value="MEDIUM">Medium</SelectItem>
                          <SelectItem value="HIGH">High</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <DialogFooter>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setIsAddProviderModelOpen(false)}
                    >
                      Cancel
                    </Button>
                    <Button type="submit" disabled={createProviderModelMutation.isPending}>
                      {createProviderModelMutation.isPending ? 'Creating...' : 'Create Model'}
                    </Button>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Provider Models ({providerModels.length})</CardTitle>
              <CardDescription>
                Model configurations from all providers
              </CardDescription>
            </CardHeader>
            <CardContent>
              {providerModelsLoading ? (
                <div className="text-center py-8 text-muted-foreground">Loading...</div>
              ) : providerModels.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  No provider models configured. Add your first model to get started.
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Provider</TableHead>
                      <TableHead>Model ID</TableHead>
                      <TableHead>Display Name</TableHead>
                      <TableHead>Input Cost</TableHead>
                      <TableHead>Output Cost</TableHead>
                      <TableHead>Max Tokens</TableHead>
                      <TableHead>Capabilities</TableHead>
                      <TableHead>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {providerModels.map((model) => (
                      <TableRow key={`${model.provider}-${model.modelId}`}>
                        <TableCell className="font-medium">{model.provider}</TableCell>
                        <TableCell>
                          <code className="text-xs">{model.modelId}</code>
                        </TableCell>
                        <TableCell>{model.displayName || '-'}</TableCell>
                        <TableCell>${model.pricing.inputCostPerMillion}/M</TableCell>
                        <TableCell>${model.pricing.outputCostPerMillion}/M</TableCell>
                        <TableCell>
                          {model.capabilities.maxInputTokens}/{model.capabilities.maxOutputTokens}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            {model.capabilities.supportsTools && (
                              <Badge variant="outline" className="text-xs">
                                Tools
                              </Badge>
                            )}
                            {model.capabilities.supportsVision && (
                              <Badge variant="outline" className="text-xs">
                                Vision
                              </Badge>
                            )}
                            {model.capabilities.supportsPdf && (
                              <Badge variant="outline" className="text-xs">
                                PDF
                              </Badge>
                            )}
                            {model.capabilities.urlContext && (
                              <Badge variant="outline" className="text-xs">
                                URL
                              </Badge>
                            )}
                            {model.capabilities.thinkingLevel !== 'NONE' && (
                              <Badge variant="outline" className="text-xs">
                                Think: {model.capabilities.thinkingLevel}
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="sm">
                                <MoreVertical className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuLabel>Actions</DropdownMenuLabel>
                              <DropdownMenuItem onClick={() => handleEditProviderModel(model)}>
                                <Edit className="mr-2 h-4 w-4" />
                                Edit
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onClick={() => handleDeleteProviderModel(model)}
                                className="text-red-600"
                              >
                                <Trash2 className="mr-2 h-4 w-4" />
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Alia Models Tab */}
        <TabsContent value="alia-models" className="space-y-4">
          <div className="flex justify-end">
            <Dialog open={isAddAliaModelOpen} onOpenChange={(open) => {
              setIsAddAliaModelOpen(open);
              if (!open) setAliaModelForm(defaultAliaModelForm);
            }}>
              <DialogTrigger asChild>
                <Button>
                  <Plus className="mr-2 h-4 w-4" />
                  Add Alia Model
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
                <form onSubmit={handleAliaModelSubmit}>
                  <DialogHeader>
                    <DialogTitle>Add Alia Virtual Model</DialogTitle>
                    <DialogDescription>
                      Create a new virtual model with provider mappings
                    </DialogDescription>
                  </DialogHeader>
                  <div className="grid gap-4 py-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div className="grid gap-2">
                        <Label htmlFor="aliasModelId">Model ID</Label>
                        <Input
                          id="aliasModelId"
                          value={aliaModelForm.aliasModelId}
                          onChange={(e) => setAliaModelForm({ ...aliaModelForm, aliasModelId: e.target.value })}
                          placeholder="alia-v1"
                          required
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label htmlFor="aliaDisplayName">Display Name</Label>
                        <Input
                          id="aliaDisplayName"
                          value={aliaModelForm.displayName}
                          onChange={(e) => setAliaModelForm({ ...aliaModelForm, displayName: e.target.value })}
                          placeholder="Alia V1"
                          required
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="grid gap-2">
                        <Label htmlFor="aliaTier">Tier</Label>
                        <Select
                          value={aliaModelForm.tier}
                          onValueChange={(value) => setAliaModelForm({ ...aliaModelForm, tier: value })}
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {ALIA_TIERS.map((t) => (
                              <SelectItem key={t} value={t}>{t}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="grid gap-2">
                        <Label htmlFor="creditMultiplier">Credit Multiplier</Label>
                        <Input
                          id="creditMultiplier"
                          type="number"
                          step="0.1"
                          min="0.1"
                          max="10"
                          value={aliaModelForm.creditMultiplier}
                          onChange={(e) => setAliaModelForm({ ...aliaModelForm, creditMultiplier: parseFloat(e.target.value) })}
                        />
                      </div>
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="aliaDescription">Description</Label>
                      <Textarea
                        id="aliaDescription"
                        value={aliaModelForm.description}
                        onChange={(e) => setAliaModelForm({ ...aliaModelForm, description: e.target.value })}
                        placeholder="Describe what this model is optimized for..."
                        rows={2}
                      />
                    </div>
                    <div className="flex items-center justify-between">
                      <Label htmlFor="isFreeTier">Available in Free Tier</Label>
                      <Switch
                        id="isFreeTier"
                        checked={aliaModelForm.isFreeTier}
                        onCheckedChange={(checked) => setAliaModelForm({ ...aliaModelForm, isFreeTier: checked })}
                      />
                    </div>

                    <Separator />
                    <div className="flex items-center justify-between">
                      <h3 className="font-semibold">Provider Mappings</h3>
                      <Button type="button" variant="outline" size="sm" onClick={addProviderMapping}>
                        <Plus className="mr-1 h-3 w-3" />
                        Add Mapping
                      </Button>
                    </div>
                    {aliaModelForm.providerMappings.length === 0 ? (
                      <p className="text-sm text-muted-foreground text-center py-2">
                        No provider mappings yet. Add mappings to route requests to provider models.
                      </p>
                    ) : (
                      <div className="space-y-3">
                        {aliaModelForm.providerMappings.map((mapping, index) => (
                          <div key={index} className="flex items-end gap-2 p-3 border rounded-md">
                            <div className="grid gap-1 flex-1">
                              <Label className="text-xs">Provider</Label>
                              <Select
                                value={mapping.provider}
                                onValueChange={(value) => updateProviderMapping(index, 'provider', value)}
                              >
                                <SelectTrigger className="h-8">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {PROVIDERS.map((p) => (
                                    <SelectItem key={p} value={p}>
                                      {p}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                            <div className="grid gap-1 flex-1">
                              <Label className="text-xs">Model ID</Label>
                              <Input
                                className="h-8"
                                value={mapping.modelId}
                                onChange={(e) => updateProviderMapping(index, 'modelId', e.target.value)}
                                placeholder="gpt-4o"
                              />
                            </div>
                            <div className="grid gap-1 w-20">
                              <Label className="text-xs">Priority</Label>
                              <Input
                                className="h-8"
                                type="number"
                                min="1"
                                max="100"
                                value={mapping.priority}
                                onChange={(e) => updateProviderMapping(index, 'priority', parseInt(e.target.value))}
                              />
                            </div>
                            <div className="grid gap-1 w-20">
                              <Label className="text-xs">Quality</Label>
                              <Input
                                className="h-8"
                                type="number"
                                min="0"
                                max="100"
                                value={mapping.qualityScore}
                                onChange={(e) => updateProviderMapping(index, 'qualityScore', parseInt(e.target.value))}
                              />
                            </div>
                            <div className="grid gap-1 w-16 items-center">
                              <Label className="text-xs">Active</Label>
                              <Switch
                                checked={mapping.isActive}
                                onCheckedChange={(checked) => updateProviderMapping(index, 'isActive', checked)}
                              />
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-8 w-8 p-0"
                              onClick={() => removeProviderMapping(index)}
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <DialogFooter>
                    <Button type="button" variant="outline" onClick={() => setIsAddAliaModelOpen(false)}>
                      Cancel
                    </Button>
                    <Button type="submit" disabled={createAliaModelMutation.isPending}>
                      {createAliaModelMutation.isPending ? 'Creating...' : 'Create Model'}
                    </Button>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Alia Virtual Models ({aliaModels.length})</CardTitle>
              <CardDescription>
                Virtual Alia models with provider mappings and priorities
              </CardDescription>
            </CardHeader>
            <CardContent>
              {aliaModelsLoading ? (
                <div className="text-center py-8 text-muted-foreground">Loading...</div>
              ) : aliaModels.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  No Alia models configured. Add your first virtual model to get started.
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Model ID</TableHead>
                      <TableHead>Display Name</TableHead>
                      <TableHead>Tier</TableHead>
                      <TableHead>Credit Multiplier</TableHead>
                      <TableHead>Provider Mappings</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {aliaModels.map((model) => (
                      <TableRow key={model._id}>
                        <TableCell>
                          <code className="text-xs">{model.aliasModelId}</code>
                        </TableCell>
                        <TableCell className="font-medium">{model.displayName}</TableCell>
                        <TableCell>
                          <Badge variant="outline">{model.tier}</Badge>
                        </TableCell>
                        <TableCell>{model.creditMultiplier}x</TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            {model.providerMappings.length === 0 ? (
                              <span className="text-xs text-muted-foreground">None</span>
                            ) : (
                              model.providerMappings
                                .sort((a, b) => a.priority - b.priority)
                                .map((m, i) => (
                                  <Badge
                                    key={i}
                                    variant={m.isActive ? 'default' : 'secondary'}
                                    className="text-xs"
                                  >
                                    {m.provider}/{m.modelId} (P{m.priority})
                                  </Badge>
                                ))
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant={model.isActive ? 'default' : 'secondary'}>
                            {model.isActive ? 'Active' : 'Inactive'}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="sm">
                                <MoreVertical className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuLabel>Actions</DropdownMenuLabel>
                              <DropdownMenuItem onClick={() => handleEditAliaModel(model)}>
                                <Edit className="mr-2 h-4 w-4" />
                                Edit
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onClick={() => handleDeleteAliaModel(model)}
                                className="text-red-600"
                              >
                                <Trash2 className="mr-2 h-4 w-4" />
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Edit Provider Model Dialog */}
      <Dialog open={isEditProviderModelOpen} onOpenChange={setIsEditProviderModelOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <form onSubmit={handleProviderModelSubmit}>
            <DialogHeader>
              <DialogTitle>Edit Provider Model</DialogTitle>
              <DialogDescription>
                Update model configuration for {selectedProviderModel?.provider}/
                {selectedProviderModel?.modelId}
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="edit-displayName">Display Name</Label>
                <Input
                  id="edit-displayName"
                  value={providerModelForm.displayName}
                  onChange={(e) =>
                    setProviderModelForm({ ...providerModelForm, displayName: e.target.value })
                  }
                />
              </div>

              <Separator />
              <h3 className="font-semibold">Pricing</h3>
              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="edit-inputCost">Input Cost (per million tokens)</Label>
                  <Input
                    id="edit-inputCost"
                    type="number"
                    step="0.01"
                    value={providerModelForm.pricing.inputCostPerMillion}
                    onChange={(e) =>
                      setProviderModelForm({
                        ...providerModelForm,
                        pricing: {
                          ...providerModelForm.pricing,
                          inputCostPerMillion: parseFloat(e.target.value),
                        },
                      })
                    }
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="edit-outputCost">Output Cost (per million tokens)</Label>
                  <Input
                    id="edit-outputCost"
                    type="number"
                    step="0.01"
                    value={providerModelForm.pricing.outputCostPerMillion}
                    onChange={(e) =>
                      setProviderModelForm({
                        ...providerModelForm,
                        pricing: {
                          ...providerModelForm.pricing,
                          outputCostPerMillion: parseFloat(e.target.value),
                        },
                      })
                    }
                  />
                </div>
              </div>

              <Separator />
              <h3 className="font-semibold">Capabilities</h3>
              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="edit-maxInputTokens">Max Input Tokens</Label>
                  <Input
                    id="edit-maxInputTokens"
                    type="number"
                    value={providerModelForm.capabilities.maxInputTokens}
                    onChange={(e) =>
                      setProviderModelForm({
                        ...providerModelForm,
                        capabilities: {
                          ...providerModelForm.capabilities,
                          maxInputTokens: parseInt(e.target.value),
                        },
                      })
                    }
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="edit-maxOutputTokens">Max Output Tokens</Label>
                  <Input
                    id="edit-maxOutputTokens"
                    type="number"
                    value={providerModelForm.capabilities.maxOutputTokens}
                    onChange={(e) =>
                      setProviderModelForm({
                        ...providerModelForm,
                        capabilities: {
                          ...providerModelForm.capabilities,
                          maxOutputTokens: parseInt(e.target.value),
                        },
                      })
                    }
                  />
                </div>
              </div>

              <div className="grid gap-3">
                <div className="flex items-center justify-between">
                  <Label htmlFor="edit-supportsStreaming">Supports Streaming</Label>
                  <Switch
                    id="edit-supportsStreaming"
                    checked={providerModelForm.capabilities.supportsStreaming}
                    onCheckedChange={(checked) =>
                      setProviderModelForm({
                        ...providerModelForm,
                        capabilities: {
                          ...providerModelForm.capabilities,
                          supportsStreaming: checked,
                        },
                      })
                    }
                  />
                </div>
                <div className="flex items-center justify-between">
                  <Label htmlFor="edit-supportsTools">Supports Tools/Function Calling</Label>
                  <Switch
                    id="edit-supportsTools"
                    checked={providerModelForm.capabilities.supportsTools}
                    onCheckedChange={(checked) =>
                      setProviderModelForm({
                        ...providerModelForm,
                        capabilities: {
                          ...providerModelForm.capabilities,
                          supportsTools: checked,
                        },
                      })
                    }
                  />
                </div>
                <div className="flex items-center justify-between">
                  <Label htmlFor="edit-supportsVision">Supports Vision</Label>
                  <Switch
                    id="edit-supportsVision"
                    checked={providerModelForm.capabilities.supportsVision}
                    onCheckedChange={(checked) =>
                      setProviderModelForm({
                        ...providerModelForm,
                        capabilities: {
                          ...providerModelForm.capabilities,
                          supportsVision: checked,
                        },
                      })
                    }
                  />
                </div>
                <div className="flex items-center justify-between">
                  <Label htmlFor="edit-supportsJsonMode">Supports JSON Mode</Label>
                  <Switch
                    id="edit-supportsJsonMode"
                    checked={providerModelForm.capabilities.supportsJsonMode}
                    onCheckedChange={(checked) =>
                      setProviderModelForm({
                        ...providerModelForm,
                        capabilities: {
                          ...providerModelForm.capabilities,
                          supportsJsonMode: checked,
                        },
                      })
                    }
                  />
                </div>
                <div className="flex items-center justify-between">
                  <Label htmlFor="edit-supportsPdf">Supports PDF</Label>
                  <Switch
                    id="edit-supportsPdf"
                    checked={providerModelForm.capabilities.supportsPdf}
                    onCheckedChange={(checked) =>
                      setProviderModelForm({
                        ...providerModelForm,
                        capabilities: {
                          ...providerModelForm.capabilities,
                          supportsPdf: checked,
                        },
                      })
                    }
                  />
                </div>
                <div className="flex items-center justify-between">
                  <Label htmlFor="edit-urlContext">URL Context</Label>
                  <Switch
                    id="edit-urlContext"
                    checked={providerModelForm.capabilities.urlContext}
                    onCheckedChange={(checked) =>
                      setProviderModelForm({
                        ...providerModelForm,
                        capabilities: {
                          ...providerModelForm.capabilities,
                          urlContext: checked,
                        },
                      })
                    }
                  />
                </div>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="edit-thinkingLevel">Thinking Level</Label>
                <Select
                  value={providerModelForm.capabilities.thinkingLevel}
                  onValueChange={(value: string) =>
                    setProviderModelForm({
                      ...providerModelForm,
                      capabilities: {
                        ...providerModelForm.capabilities,
                        thinkingLevel: value as 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH',
                      },
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="NONE">None</SelectItem>
                    <SelectItem value="LOW">Low</SelectItem>
                    <SelectItem value="MEDIUM">Medium</SelectItem>
                    <SelectItem value="HIGH">High</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setIsEditProviderModelOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={updateProviderModelMutation.isPending}>
                {updateProviderModelMutation.isPending ? 'Updating...' : 'Update Model'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Provider Model Dialog */}
      <Dialog open={isDeleteProviderModelOpen} onOpenChange={setIsDeleteProviderModelOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Provider Model</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this model? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              This will permanently delete: <strong>{selectedProviderModel?.provider}</strong> /{' '}
              <strong>{selectedProviderModel?.modelId}</strong>
            </AlertDescription>
          </Alert>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setIsDeleteProviderModelOpen(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                selectedProviderModel &&
                deleteProviderModelMutation.mutate({
                  provider: selectedProviderModel.provider,
                  modelId: selectedProviderModel.modelId,
                })
              }
              disabled={deleteProviderModelMutation.isPending}
            >
              {deleteProviderModelMutation.isPending ? 'Deleting...' : 'Delete Model'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* Edit Alia Model Dialog */}
      <Dialog open={isEditAliaModelOpen} onOpenChange={setIsEditAliaModelOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <form onSubmit={handleAliaModelSubmit}>
            <DialogHeader>
              <DialogTitle>Edit Alia Model</DialogTitle>
              <DialogDescription>
                Update configuration for {selectedAliaModel?.aliasModelId}
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label>Model ID</Label>
                  <Input value={aliaModelForm.aliasModelId} disabled />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="edit-aliaDisplayName">Display Name</Label>
                  <Input
                    id="edit-aliaDisplayName"
                    value={aliaModelForm.displayName}
                    onChange={(e) => setAliaModelForm({ ...aliaModelForm, displayName: e.target.value })}
                    required
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="edit-aliaTier">Tier</Label>
                  <Select
                    value={aliaModelForm.tier}
                    onValueChange={(value) => setAliaModelForm({ ...aliaModelForm, tier: value })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ALIA_TIERS.map((t) => (
                        <SelectItem key={t} value={t}>{t}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="edit-creditMultiplier">Credit Multiplier</Label>
                  <Input
                    id="edit-creditMultiplier"
                    type="number"
                    step="0.1"
                    min="0.1"
                    max="10"
                    value={aliaModelForm.creditMultiplier}
                    onChange={(e) => setAliaModelForm({ ...aliaModelForm, creditMultiplier: parseFloat(e.target.value) })}
                  />
                </div>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="edit-aliaDescription">Description</Label>
                <Textarea
                  id="edit-aliaDescription"
                  value={aliaModelForm.description}
                  onChange={(e) => setAliaModelForm({ ...aliaModelForm, description: e.target.value })}
                  rows={2}
                />
              </div>
              <div className="flex items-center justify-between">
                <Label htmlFor="edit-isFreeTier">Available in Free Tier</Label>
                <Switch
                  id="edit-isFreeTier"
                  checked={aliaModelForm.isFreeTier}
                  onCheckedChange={(checked) => setAliaModelForm({ ...aliaModelForm, isFreeTier: checked })}
                />
              </div>

              <Separator />
              <div className="flex items-center justify-between">
                <h3 className="font-semibold">Provider Mappings</h3>
                <Button type="button" variant="outline" size="sm" onClick={addProviderMapping}>
                  <Plus className="mr-1 h-3 w-3" />
                  Add Mapping
                </Button>
              </div>
              {aliaModelForm.providerMappings.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-2">
                  No provider mappings yet.
                </p>
              ) : (
                <div className="space-y-3">
                  {aliaModelForm.providerMappings.map((mapping, index) => (
                    <div key={index} className="flex items-end gap-2 p-3 border rounded-md">
                      <div className="grid gap-1 flex-1">
                        <Label className="text-xs">Provider</Label>
                        <Select
                          value={mapping.provider}
                          onValueChange={(value) => updateProviderMapping(index, 'provider', value)}
                        >
                          <SelectTrigger className="h-8">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {PROVIDERS.map((p) => (
                              <SelectItem key={p} value={p}>{p}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="grid gap-1 flex-1">
                        <Label className="text-xs">Model ID</Label>
                        <Input
                          className="h-8"
                          value={mapping.modelId}
                          onChange={(e) => updateProviderMapping(index, 'modelId', e.target.value)}
                          placeholder="gpt-4o"
                        />
                      </div>
                      <div className="grid gap-1 w-20">
                        <Label className="text-xs">Priority</Label>
                        <Input
                          className="h-8"
                          type="number"
                          min="1"
                          max="100"
                          value={mapping.priority}
                          onChange={(e) => updateProviderMapping(index, 'priority', parseInt(e.target.value))}
                        />
                      </div>
                      <div className="grid gap-1 w-20">
                        <Label className="text-xs">Quality</Label>
                        <Input
                          className="h-8"
                          type="number"
                          min="0"
                          max="100"
                          value={mapping.qualityScore}
                          onChange={(e) => updateProviderMapping(index, 'qualityScore', parseInt(e.target.value))}
                        />
                      </div>
                      <div className="grid gap-1 w-16 items-center">
                        <Label className="text-xs">Active</Label>
                        <Switch
                          checked={mapping.isActive}
                          onCheckedChange={(checked) => updateProviderMapping(index, 'isActive', checked)}
                        />
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 p-0"
                        onClick={() => removeProviderMapping(index)}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setIsEditAliaModelOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={updateAliaModelMutation.isPending}>
                {updateAliaModelMutation.isPending ? 'Updating...' : 'Update Model'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Alia Model Dialog */}
      <Dialog open={isDeleteAliaModelOpen} onOpenChange={setIsDeleteAliaModelOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Alia Model</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this virtual model? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              This will permanently delete: <strong>{selectedAliaModel?.aliasModelId}</strong> ({selectedAliaModel?.displayName})
            </AlertDescription>
          </Alert>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setIsDeleteAliaModelOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => selectedAliaModel && deleteAliaModelMutation.mutate(selectedAliaModel.aliasModelId)}
              disabled={deleteAliaModelMutation.isPending}
            >
              {deleteAliaModelMutation.isPending ? 'Deleting...' : 'Delete Model'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
