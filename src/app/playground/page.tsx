import { type Metadata } from "next"
import { RotateCcw } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
    HoverCard,
    HoverCardContent,
    HoverCardTrigger,
} from "@/components/ui/hover-card"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import {
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
} from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"

import { CodeViewer } from "./components/code-viewer"
import { MaxLengthSelector } from "./components/maxlength-selector"
import { ModelSelector } from "./components/model-selector"
import { PresetActions } from "./components/preset-actions"
import { PresetSave } from "./components/preset-save"
import { PresetSelector } from "./components/preset-selector"
import { PresetShare } from "./components/preset-share"
import { TemperatureSelector } from "./components/temperature-selector"
import { TopPSelector } from "./components/top-p-selector"
import { models, types } from "./data/models"
import { presets } from "./data/presets"

export const metadata: Metadata = {
    title: "Playground",
    description: "AI Playground for testing prompts and models.",
}

export default function PlaygroundPage() {
    return (
        <div className="flex flex-1 flex-col">
            <div className="flex flex-col items-start justify-between gap-4 px-4 py-4 sm:flex-row sm:items-center sm:gap-2">
                <h2 className="text-lg font-semibold">Playground</h2>
                <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
                    <PresetSelector presets={presets} />
                    <PresetSave />
                    <CodeViewer />
                    <PresetShare />
                    <PresetActions />
                </div>
            </div>
            <Separator />
            <Tabs defaultValue="complete" className="flex flex-1 flex-col overflow-hidden">
                <div className="flex flex-1 flex-col gap-6 p-4 overflow-hidden">
                    <div className="grid flex-1 gap-6 overflow-hidden lg:grid-cols-[1fr_280px]">
                        <div className="flex flex-1 flex-col overflow-hidden lg:order-1">
                            <TabsContent value="complete" className="m-0 flex-1 overflow-auto">
                                <div className="flex h-full flex-col gap-4">
                                    <Textarea
                                        placeholder="Write a tagline for an ice cream shop"
                                        className="min-h-[400px] flex-1 p-4 resize-none"
                                    />
                                    <div className="flex items-center gap-2">
                                        <Button>Submit</Button>
                                        <Button variant="secondary">
                                            <RotateCcw className="h-4 w-4" />
                                            <span className="sr-only">Show history</span>
                                        </Button>
                                    </div>
                                </div>
                            </TabsContent>
                            <TabsContent
                                value="insert"
                                className="m-0 flex flex-1 flex-col gap-4 overflow-auto"
                            >
                                <div className="grid h-full gap-6 lg:grid-cols-2">
                                    <Textarea
                                        placeholder="We're writing to [insert]. Congrats from OpenAI!"
                                        className="min-h-[300px] p-4 resize-none lg:min-h-[500px]"
                                    />
                                    <div className="bg-muted min-h-[300px] rounded-md border lg:min-h-[500px]"></div>
                                </div>
                                <div className="flex items-center gap-2">
                                    <Button>Submit</Button>
                                    <Button variant="secondary">
                                        <RotateCcw className="h-4 w-4" />
                                        <span className="sr-only">Show history</span>
                                    </Button>
                                </div>
                            </TabsContent>
                            <TabsContent
                                value="edit"
                                className="m-0 flex flex-1 flex-col gap-4 overflow-auto"
                            >
                                <div className="grid h-full gap-6 lg:grid-cols-2">
                                    <div className="flex flex-col gap-4">
                                        <div className="flex flex-1 flex-col gap-2">
                                            <Label htmlFor="input" className="sr-only">
                                                Input
                                            </Label>
                                            <Textarea
                                                id="input"
                                                placeholder="We is going to the market."
                                                className="flex-1 p-4 resize-none min-h-[300px] lg:min-h-[450px]"
                                            />
                                        </div>
                                        <div className="flex flex-col gap-2">
                                            <Label htmlFor="instructions">Instructions</Label>
                                            <Textarea
                                                id="instructions"
                                                placeholder="Fix the grammar."
                                                className="resize-none"
                                            />
                                        </div>
                                    </div>
                                    <div className="bg-muted min-h-[300px] rounded-md border lg:min-h-[500px]" />
                                </div>
                                <div className="flex items-center gap-2">
                                    <Button>Submit</Button>
                                    <Button variant="secondary">
                                        <RotateCcw className="h-4 w-4" />
                                        <span className="sr-only">Show history</span>
                                    </Button>
                                </div>
                            </TabsContent>
                        </div>
                        <div className="flex flex-col gap-6 lg:order-2">
                            <div className="flex flex-col gap-3">
                                <HoverCard openDelay={200}>
                                    <HoverCardTrigger asChild>
                                        <Label className="cursor-help">Mode</Label>
                                    </HoverCardTrigger>
                                    <HoverCardContent className="w-80 text-sm" side="left">
                                        Choose the interface that best suits your task. You can
                                        provide: a simple prompt to complete, starting and ending
                                        text to insert a completion within, or some text with
                                        instructions to edit it.
                                    </HoverCardContent>
                                </HoverCard>
                                <TabsList className="grid w-full grid-cols-3">
                                    <TabsTrigger value="complete">
                                        <span className="sr-only">Complete</span>
                                        <svg
                                            xmlns="http://www.w3.org/2000/svg"
                                            viewBox="0 0 20 20"
                                            fill="none"
                                            className="h-5 w-5"
                                        >
                                            <rect
                                                x="4"
                                                y="3"
                                                width="12"
                                                height="2"
                                                rx="1"
                                                fill="currentColor"
                                            ></rect>
                                            <rect
                                                x="4"
                                                y="7"
                                                width="12"
                                                height="2"
                                                rx="1"
                                                fill="currentColor"
                                            ></rect>
                                            <rect
                                                x="4"
                                                y="11"
                                                width="3"
                                                height="2"
                                                rx="1"
                                                fill="currentColor"
                                            ></rect>
                                            <rect
                                                x="4"
                                                y="15"
                                                width="3"
                                                height="2"
                                                rx="1"
                                                fill="currentColor"
                                            ></rect>
                                            <rect
                                                x="8.5"
                                                y="11"
                                                width="3"
                                                height="2"
                                                rx="1"
                                                fill="currentColor"
                                            ></rect>
                                            <rect
                                                x="8.5"
                                                y="15"
                                                width="3"
                                                height="2"
                                                rx="1"
                                                fill="currentColor"
                                            ></rect>
                                            <rect
                                                x="13"
                                                y="11"
                                                width="3"
                                                height="2"
                                                rx="1"
                                                fill="currentColor"
                                            ></rect>
                                        </svg>
                                    </TabsTrigger>
                                    <TabsTrigger value="insert">
                                        <span className="sr-only">Insert</span>
                                        <svg
                                            xmlns="http://www.w3.org/2000/svg"
                                            viewBox="0 0 20 20"
                                            fill="none"
                                            className="h-5 w-5"
                                        >
                                            <path
                                                fillRule="evenodd"
                                                clipRule="evenodd"
                                                d="M14.491 7.769a.888.888 0 0 1 .287.648.888.888 0 0 1-.287.648l-3.916 3.667a1.013 1.013 0 0 1-.692.268c-.26 0-.509-.097-.692-.268L5.275 9.065A.886.886 0 0 1 5 8.42a.889.889 0 0 1 .287-.64c.181-.17.427-.267.683-.269.257-.002.504.09.69.258L8.903 9.87V3.917c0-.243.103-.477.287-.649.183-.171.432-.268.692-.268.26 0 .509.097.692.268a.888.888 0 0 1 .287.649V9.87l2.245-2.102c.183-.172.432-.269.692-.269.26 0 .508.097.692.269Z"
                                                fill="currentColor"
                                            ></path>
                                            <rect
                                                x="4"
                                                y="15"
                                                width="3"
                                                height="2"
                                                rx="1"
                                                fill="currentColor"
                                            ></rect>
                                            <rect
                                                x="8.5"
                                                y="15"
                                                width="3"
                                                height="2"
                                                rx="1"
                                                fill="currentColor"
                                            ></rect>
                                            <rect
                                                x="13"
                                                y="15"
                                                width="3"
                                                height="2"
                                                rx="1"
                                                fill="currentColor"
                                            ></rect>
                                        </svg>
                                    </TabsTrigger>
                                    <TabsTrigger value="edit">
                                        <span className="sr-only">Edit</span>
                                        <svg
                                            xmlns="http://www.w3.org/2000/svg"
                                            viewBox="0 0 20 20"
                                            fill="none"
                                            className="h-5 w-5"
                                        >
                                            <rect
                                                x="4"
                                                y="3"
                                                width="12"
                                                height="2"
                                                rx="1"
                                                fill="currentColor"
                                            ></rect>
                                            <rect
                                                x="4"
                                                y="7"
                                                width="12"
                                                height="2"
                                                rx="1"
                                                fill="currentColor"
                                            ></rect>
                                            <rect
                                                x="4"
                                                y="11"
                                                width="3"
                                                height="2"
                                                rx="1"
                                                fill="currentColor"
                                            ></rect>
                                            <rect
                                                x="4"
                                                y="15"
                                                width="4"
                                                height="2"
                                                rx="1"
                                                fill="currentColor"
                                            ></rect>
                                            <rect
                                                x="8.5"
                                                y="11"
                                                width="3"
                                                height="2"
                                                rx="1"
                                                fill="currentColor"
                                            ></rect>
                                            <path
                                                d="M17.154 11.346a1.182 1.182 0 0 0-1.671 0L11 15.829V17.5h1.671l4.483-4.483a1.182 1.182 0 0 0 0-1.671Z"
                                                fill="currentColor"
                                            ></path>
                                        </svg>
                                    </TabsTrigger>
                                </TabsList>
                            </div>
                            <ModelSelector types={types} models={models} />
                            <TemperatureSelector defaultValue={[0.56]} />
                            <MaxLengthSelector defaultValue={[256]} />
                            <TopPSelector defaultValue={[0.9]} />
                        </div>
                    </div>
                </div>
            </Tabs>
        </div>
    )
}
