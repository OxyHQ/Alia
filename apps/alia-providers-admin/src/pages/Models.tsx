import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxyhq/auth';
import { apiClient } from '@/lib/api/client';
import { useRealtimeModels } from '@/lib/websocket/hooks';
import { ALIA_TIERS } from '@/types';
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

const PROVIDERS = [
  'openai',
  'anthropic',
  'google',
  'groq',
  'mistral',
  'deepseek',
  'together',
  'cerebras',
  'cloudflare',
  'openrouter',
  'cohere',
];

export function ModelsPage() {
  const [activeTab, setActiveTab] = useState('provider-models');
  const [isAddProviderModelOpen, setIsAddProviderModelOpen] = useState(false);
  const [isEditProviderModelOpen, setIsEditProviderModelOpen] = useState(false);
  const [isDeleteProviderModelOpen, setIsDeleteProviderModelOpen] = useState(false);
  const [selectedProviderModel, setSelectedProviderModel] = useState<ModelConfig | null>(null);

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
  const { data: realtimeAliaModelsData, isConnected: aliaModelsConnected } = useRealtimeModels({ aliaTier: 'all' });

  // Fallback to polling if WebSocket is not connected
  const { data: polledProviderModelsData, isLoading: providerModelsLoading } = useQuery({
    queryKey: ['provider-models'],
    queryFn: () => apiClient.listModels(),
    refetchInterval: providerModelsConnected ? false : 60000,
    enabled: isAuthenticated && !providerModelsConnected,
  });

  const { data: polledAliaModelsData } = useQuery({
    queryKey: ['alia-models'],
    queryFn: () => apiClient.listModels({ aliaTier: 'all' }),
    refetchInterval: aliaModelsConnected ? false : 60000,
    enabled: isAuthenticated && !aliaModelsConnected,
  });

  // Use real-time data if available, otherwise fall back to polled data
  const providerModelsData = realtimeProviderModelsData || polledProviderModelsData;
  const aliaModelsData = realtimeAliaModelsData || polledAliaModelsData;

  const providerModels: ModelConfig[] = (providerModelsData as any)?.data || [];
  const aliaModels: AliaModel[] = (aliaModelsData as any)?.data || [];

  // Create provider model mutation
  const createProviderModelMutation = useMutation({
    mutationFn: (data: any) => apiClient.createModel(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['provider-models'] });
      setIsAddProviderModelOpen(false);
      resetProviderModelForm();
    },
  });

  // Update provider model mutation
  const updateProviderModelMutation = useMutation({
    mutationFn: ({ provider, modelId, data }: { provider: string; modelId: string; data: any }) =>
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
                        onValueChange={(value: any) =>
                          setProviderModelForm({
                            ...providerModelForm,
                            capabilities: {
                              ...providerModelForm.capabilities,
                              thinkingLevel: value,
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
          <Card>
            <CardHeader>
              <CardTitle>Alia Virtual Models ({aliaModels.length})</CardTitle>
              <CardDescription>
                Virtual Alia models with provider mappings (Coming soon)
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-center py-8 text-muted-foreground">
                Alia Models management interface coming soon. Configure virtual models like
                alia-v1, alia-lite with provider mappings and priorities.
              </div>
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
                  onValueChange={(value: any) =>
                    setProviderModelForm({
                      ...providerModelForm,
                      capabilities: {
                        ...providerModelForm.capabilities,
                        thinkingLevel: value,
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
    </div>
  );
}
