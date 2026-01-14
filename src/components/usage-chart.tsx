"use client"

import * as React from "react"
import { Area, AreaChart, CartesianGrid, XAxis } from "recharts"
import { useTranslations } from 'next-intl'

import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card"
import {
    ChartConfig,
    ChartContainer,
    ChartLegend,
    ChartLegendContent,
    ChartTooltip,
    ChartTooltipContent,
} from "@/components/ui/chart"
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select"

const chartData = [
    { date: "2024-04-01", google: 222, openai: 150 },
    { date: "2024-04-02", google: 97, openai: 180 },
    { date: "2024-04-03", google: 167, openai: 120 },
    { date: "2024-04-04", google: 242, openai: 260 },
    { date: "2024-04-05", google: 373, openai: 290 },
    { date: "2024-04-06", google: 301, openai: 340 },
    { date: "2024-04-07", google: 245, openai: 180 },
    { date: "2024-04-08", google: 409, openai: 320 },
    { date: "2024-04-09", google: 59, openai: 110 },
    { date: "2024-04-10", google: 261, openai: 190 },
    { date: "2024-04-11", google: 327, openai: 350 },
    { date: "2024-04-12", google: 292, openai: 210 },
    { date: "2024-04-13", google: 342, openai: 380 },
    { date: "2024-04-14", google: 137, openai: 220 },
    { date: "2024-04-15", google: 120, openai: 170 },
    { date: "2024-04-16", google: 138, openai: 190 },
    { date: "2024-04-17", google: 446, openai: 360 },
    { date: "2024-04-18", google: 364, openai: 410 },
    { date: "2024-04-19", google: 243, openai: 180 },
    { date: "2024-04-20", google: 89, openai: 150 },
]

const chartConfig = {
    visitos: {
        label: "Total Requests",
    },
    google: {
        label: "Google Gemini",
        color: "hsl(var(--chart-1))",
    },
    openai: {
        label: "OpenAI",
        color: "hsl(var(--chart-2))",
    },
} satisfies ChartConfig

export function UsageChart() {
    const [timeRange, setTimeRange] = React.useState("90d")
    const t = useTranslations('admin.chart')

    return (
        <Card className="h-full">
            <CardHeader className="flex items-center gap-2 space-y-0 border-b py-5 sm:flex-row">
                <div className="grid flex-1 gap-1 text-center sm:text-left">
                    <CardTitle>{t('title')}</CardTitle>
                    <CardDescription>
                        {t('description')}
                    </CardDescription>
                </div>
                <Select value={timeRange} onValueChange={setTimeRange}>
                    <SelectTrigger
                        className="w-[160px] rounded-lg sm:ml-auto"
                        aria-label="Select a value"
                    >
                        <SelectValue placeholder={t('last3Months')} />
                    </SelectTrigger>
                    <SelectContent className="rounded-xl">
                        <SelectItem value="90d" className="rounded-lg">
                            {t('last3Months')}
                        </SelectItem>
                        <SelectItem value="30d" className="rounded-lg">
                            {t('last30Days')}
                        </SelectItem>
                        <SelectItem value="7d" className="rounded-lg">
                            {t('last7Days')}
                        </SelectItem>
                    </SelectContent>
                </Select>
            </CardHeader>
            <CardContent className="px-2 pt-4 sm:px-6 sm:pt-6">
                <ChartContainer
                    config={chartConfig}
                    className="aspect-auto h-[250px] w-full"
                >
                    <AreaChart data={chartData}>
                        <defs>
                            <linearGradient id="fillGoogle" x1="0" y1="0" x2="0" y2="1">
                                <stop
                                    offset="5%"
                                    stopColor="var(--color-google)"
                                    stopOpacity={0.8}
                                />
                                <stop
                                    offset="95%"
                                    stopColor="var(--color-google)"
                                    stopOpacity={0.1}
                                />
                            </linearGradient>
                            <linearGradient id="fillOpenAI" x1="0" y1="0" x2="0" y2="1">
                                <stop
                                    offset="5%"
                                    stopColor="var(--color-openai)"
                                    stopOpacity={0.8}
                                />
                                <stop
                                    offset="95%"
                                    stopColor="var(--color-openai)"
                                    stopOpacity={0.1}
                                />
                            </linearGradient>
                        </defs>
                        <CartesianGrid vertical={false} />
                        <XAxis
                            dataKey="date"
                            tickLine={false}
                            axisLine={false}
                            tickMargin={8}
                            minTickGap={32}
                            tickFormatter={(value) => {
                                const date = new Date(value)
                                return date.toLocaleDateString("en-US", {
                                    month: "short",
                                    day: "numeric",
                                })
                            }}
                        />
                        <ChartTooltip
                            cursor={false}
                            content={
                                <ChartTooltipContent
                                    labelFormatter={(value) => {
                                        return new Date(value).toLocaleDateString("en-US", {
                                            month: "short",
                                            day: "numeric",
                                        })
                                    }}
                                    indicator="dot"
                                />
                            }
                        />
                        <Area
                            dataKey="openai"
                            type="natural"
                            fill="url(#fillOpenAI)"
                            stroke="var(--color-openai)"
                            stackId="a"
                        />
                        <Area
                            dataKey="google"
                            type="natural"
                            fill="url(#fillGoogle)"
                            stroke="var(--color-google)"
                            stackId="a"
                        />
                        <ChartLegend content={<ChartLegendContent />} />
                    </AreaChart>
                </ChartContainer>
            </CardContent>
        </Card>
    )
}
