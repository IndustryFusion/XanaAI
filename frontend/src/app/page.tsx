// 
// Copyright (c) 2025 Industry Fusion Foundation
// 
// Licensed under the Apache License, Version 2.0 (the "License"); 
// you may not use this file except in compliance with the License. 
// You may obtain a copy of the License at 
// 
//   http://www.apache.org/licenses/LICENSE-2.0 
// 
// Unless required by applicable law or agreed to in writing, software 
// distributed under the License is distributed on an "AS IS" BASIS, 
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. 
// See the License for the specific language governing permissions and 
// limitations under the License. 
// 

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import PromptBox from '../components/PromptBox';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Chart } from 'primereact/chart';
import { Toast } from "primereact/toast";
import axios from "axios";
import { getAccessGroupData, showToast } from "@/utility/tools";

type Message = { role: 'user' | 'system'; content: string, series?: Array<{ t: number | string; v: number }>, alerts?: Record<string, any>[] | null };
type AssetOpt = { asset_name: string; vector_store_id: string };
const ALL_OPTION = '__ALL__';
// put this near the top of your component file
const API = process.env.NEXT_PUBLIC_API_BASE ?? ''; // e.g. "http://localhost:3001"


export default function Home() {
  const [assets, setAssets] = useState<AssetOpt[]>([]);
  const [vectorId, setVectorId] = useState<string>(ALL_OPTION);     // holds vector_store_id
  const [conversation, setConversation] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const toast = useRef<Toast>(null!) as React.RefObject<Toast>;
  const [login, setLogin] = useState(false);

  const chatContainerRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const setIndexedDb = async (token: string) => {
    try {
      // fetch access data and store in indexed db and route to asset-overview.
      await getAccessGroupData(token);
      setLogin(true);
    } catch (error: any) {
      console.log("error inside page ", error);
      setLogin(false);
      if (axios.isAxiosError(error)) {
        if (error?.response && error?.response?.status === 401) {
          showToast(toast, "error", "Unauthorized", "Invalid token");
        } else {
          console.error("Error response:", error.response?.data.message);
          showToast(toast, "error", "Error", "Error during login");
        }
      } else {
        console.error("Error:", error);
        showToast(toast, "error", "Error", error);
      }
    }
  }

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [conversation, loading]);

  // Load assets and auto-select the first one
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const token = urlParams.get('token');
    if (token) {
      setIndexedDb(token);
      let mounted = true;
      fetch(`${API}/vector-mappings`)
        .then(r => r.json())
        .then(res => {
          if (!mounted) return;
          console.log('Assets loaded:', res);
          const list: AssetOpt[] = res.data || [];
          setAssets(list);
          if (list.length && !vectorId) setVectorId(list[0].vector_store_id);
        })
        .catch(() => setAssets([]));
      return () => { mounted = false; };
    }
    else {
      // change here for DEV mode
      setLogin(false);
      showToast(toast, "error", "Unauthorized", "Open the application from IFX suite.");
    }

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handlePromptSubmit = async (query: string) => {
    if (!query.trim()) return;

    const vectorStoreIds =
      vectorId === ALL_OPTION
        ? assets.map(a => a.asset_name).filter(Boolean)
        : [vectorId].filter(Boolean);

    // if (!vectorStoreIds.length) {
    //   setConversation(prev => [...prev, { role: 'system', content: 'Select an asset first.' }]);
    //   return;
    // }

    setLoading(true);
    const messages: Message[] = [...conversation, { role: 'user', content: query }];
    setConversation(messages);

    try {
      const res = await fetch(`${API}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages,
          vectorStoreIds,
          assets, // optional, used by router
        }),
      });

      const data = await res.json();
      if (data.first10 && data.first10.length > 0 || data.alerts && data.alerts.length > 0) {
        setConversation(prev => [...prev, { role: 'system', content: data.reply ?? 'Something went wrong please try again.', series: data.first10, alerts: data.alerts ?? null }]);
      }
      else {
        setConversation(prev => [...prev, { role: 'system', content: data.reply ?? 'Something went wrong please try again.', series: [], alerts: null }]);
      }

      // Test IONOS API Here
      // const res2 = await fetch(`${API}/ai/chat`, {
      //   method: 'POST',
      //   headers: { 'Content-Type': 'application/json' },
      //   body: JSON.stringify({
      //     messages,
      //     temperature: 0.7,
      //     extra: {
      //       top_p: 0.9,
      //       n: 1
      //     },
      //     maxTokens: 1024,
      //      // optional, used by router
      //   }),
      // });

      // const data = await res2.json();
      // console.log('IONOS API response:', data);
      // setConversation(prev => [...prev, { role: 'system', content: data.choices[0]?.message.content ?? 'No reply.' }]);

    } catch (err: any) {
      setConversation(prev => [...prev, { role: 'system', content: `Error: ${err?.message || 'request failed'}` }]);
    } finally {
      setLoading(false);
    }
  };

  const [chatBgTheme, setChatBgTheme] = useState<'dark' | 'white'>(() => {
    if (typeof window === 'undefined') return 'dark';
    return (localStorage.getItem('chatBgTheme') as 'dark' | 'white') || 'dark';
  });

  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('chatBgTheme', chatBgTheme);
    }
  }, [chatBgTheme]);

  // const chartData = useMemo(() => ({
  //   labels: series.map(p => (typeof p.t === 'number' ? String(p.t) : p.t)),
  //   datasets: [
  //     {
  //       label: 'value',
  //       data: series.map(p => p.v),
  //       borderWidth: 2,
  //       fill: false,
  //       tension: 0.25, // slight smoothing
  //     },
  //   ],
  // }), [series]);

  // const chartOptions = useMemo(() => ({
  //   responsive: true,
  //   maintainAspectRatio: false,
  //   plugins: { legend: { display: true } },
  //   scales: { x: { ticks: { autoSkip: true, maxRotation: 0 } } },
  // }), []);


  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        labels: { color: '#e5e7eb', boxWidth: 12, boxHeight: 12 },
      },
      tooltip: {
        backgroundColor: '#0b0b0b',
        titleColor: '#f3f4f6',
        bodyColor: '#e5e7eb',
        borderColor: '#1f2937',
        borderWidth: 1,
      },
    },
    scales: {
      x: {
        ticks: { color: '#9ca3af' },
        grid: { color: 'rgba(255,255,255,0.06)' },
      },
      y: {
        ticks: { color: '#9ca3af' },
        grid: { color: 'rgba(255,255,255,0.06)' },
      },
    },
    elements: { point: { radius: 2 } }
  };

  return (
    <>
      <Toast ref={toast} />
      {login && (
        <main className="flex flex-col h-screen bg-neutral-900 text-neutral-100 
  bg-[radial-gradient(1200px_800px_at_80%_-10%,rgba(99,102,241,0.08),transparent_60%),radial-gradient(900px_600px_at_10%_120%,rgba(168,85,247,0.08),transparent_60%)]">

          {/* Header */}
          <header
            className={`px-5 py-3 border-b sticky top-0 z-10 backdrop-blur-md
    ${chatBgTheme === 'white'
                ? 'bg-white border-gray-200 text-gray-900'
                : 'bg-neutral-900/70 border-white/10 text-neutral-100'}
  `}
          >
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  {/* Icon SVG */}

                  <img className="w-8 h-8" src="xana-circle.svg" alt="" />

                  {/* Heading */}
                  <h1
                    className={`text-xl font-mono font-bold tracking-wide
        ${chatBgTheme === "white"
                        ? "text-black-800 drop-shadow-none"
                        : "text-white-400 drop-shadow-[0_0_8px_rgba(56,189,248,0.45)]"
                      }`}
                    style={{ fontFamily: "League Spartan", fontSize: "24px" }}
                  >
                    Xana AI
                  </h1>
                </div>

                <h4
                  className={`text-[11px] font-mono tracking-wider ${chatBgTheme === "white" ? "text-black-500" : "text-white-300/80"
                    }`}
                >
                  Powered by IndustryFusion
                </h4>
              </div>


              {/* Machines dropdown */}
              <div className="min-w-[200px]">
                <label className="block text-[10px] uppercase tracking-wider text-gray-400 mb-1">
                  Machines
                </label>
                <select
                  value={vectorId}
                  onChange={(e) => setVectorId(e.target.value)}
                  className={`w-full rounded-xl border px-3 py-2 text-sm outline-none
          ${chatBgTheme === 'white'
                      ? 'bg-white border-gray-300 text-gray-900 focus:ring-sky-400'
                      : 'bg-neutral-900/80 border-white/10 text-neutral-100 focus:ring-indigo-500/60'}
        `}
                >
                  {!assets.length && <option>Loading…</option>}
                  <option value={ALL_OPTION}>All machines</option>
                  {assets.map(a => (
                    <option key={a.vector_store_id} value={a.asset_name}>
                      {a.asset_name}
                    </option>
                  ))}
                </select>
              </div>

              {/* Theme selector */}
              <div className="min-w-[200px]">
                <label className="block text-[10px] uppercase tracking-wider text-gray-400 mb-1">
                  Theme
                </label>
                <select
                  value={chatBgTheme}
                  onChange={(e) => setChatBgTheme(e.target.value as 'dark' | 'white')}
                  className={`w-full rounded-xl border px-3 py-2 text-sm outline-none
          ${chatBgTheme === 'white'
                      ? 'bg-white border-gray-300 text-gray-900 focus:ring-sky-400'
                      : 'bg-neutral-900/80 border-white/10 text-neutral-100 focus:ring-indigo-500/60'}
        `}
                >
                  <option value="dark">Dark theme</option>
                  <option value="white">White theme</option>
                </select>
              </div>
            </div>
          </header>

          {/* Conversation */}
          <div className={`flex-1 overflow-y-auto p-4 space-y-3 custom-scroll ${chatBgTheme === 'white' ? 'bg-white' : 'bg-neutral-900/15'
            }`} ref={chatContainerRef}>
            {conversation.map((msg, idx) => {
              const isUser = msg.role === 'user';

              // choose colors depending on theme + role
              const bubbleClasses =
                chatBgTheme === 'white'
                  ? isUser
                    ? "bg-sky-100 text-gray-900 border border-sky-200"
                    : "bg-gray-100 text-gray-800 border border-gray-300"
                  : isUser
                    ? "bg-emerald-600/20 text-emerald-200 border border-emerald-500/30"
                    : "bg-neutral-800/80 text-emerald-200 border border-white/10";

              return (
                <div key={idx} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
                  <div
                    className={`max-w-[75%] p-4 rounded-2xl shadow-sm transition-transform ${bubbleClasses}`}
                  >
                    <div className="mb-1 flex items-center gap-2">
                      <span
                        className={`inline-flex items-center justify-center rounded-full px-2 py-0.5 text-[10px] font-medium
              ${chatBgTheme === 'white'
                            ? isUser
                              ? 'bg-sky-200 text-gray-900'
                              : 'bg-gray-300 text-gray-800'
                            : isUser
                              ? 'bg-emerald-600/30 text-emerald-100'
                              : 'bg-indigo-500/20 text-indigo-200'}
            `}
                      >
                        {isUser ? 'You' : 'XANA'}
                      </span>
                    </div>

                    {isUser ? (
                      <div className="font-mono leading-relaxed whitespace-pre-wrap">
                        {msg.content}
                      </div>
                    ) : (
                      <div className={`prose prose-sm max-w-none font-mono whitespace-pre-line break-words
            ${chatBgTheme === 'white'
                          ? 'prose-gray text-gray-800'
                          : 'prose-invert text-emerald-200'}
          `}>
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {msg.content}
                        </ReactMarkdown>
                      </div>
                    )}

                    {/* charts for XANA */}
                    {!isUser && (msg.series?.length ?? 0) > 0 && (
                      <div className="mt-3">
                        <h5 className="text-sm font-semibold mb-2">Data in Chart</h5>
                        <div
                          className={`h-[260px] rounded-xl p-2
                ${chatBgTheme === 'white'
                              ? 'bg-gray-100 border border-gray-300'
                              : 'bg-neutral-900/60 border border-white/10'}
              `}
                        >
                          <Chart
                            type="line"
                            data={{
                              labels: msg?.series?.map(p =>
                                typeof p.t === 'number' ? String(p.t) : p.t
                              ),
                              datasets: [
                                {
                                  label: 'value',
                                  data: msg?.series?.map(p => p.v),
                                  borderWidth: 2,
                                  fill: false,
                                  tension: 0.25,
                                  borderColor:
                                    chatBgTheme === 'white' ? '#0ea5e9' : '#6366f1',
                                  pointBackgroundColor:
                                    chatBgTheme === 'white' ? '#0284c7' : '#a78bfa',
                                },
                              ],
                            }}
                            options={chartOptions}
                          />
                        </div>
                      </div>
                    )}


                    {!isUser && (msg.alerts?.length ?? 0) > 0 && (() => {
                      const total = (msg.alerts ?? []).length
                      const severityCounts = (msg.alerts ?? []).reduce((acc, a) => {
                        acc[a.severity] = (acc[a.severity] || 0) + 1
                        return acc
                      }, {} as Record<string, number>)
                      const statusCounts = (msg.alerts ?? []).reduce((acc, a) => {
                        acc[a.status] = (acc[a.status] || 0) + 1
                        return acc
                      }, {} as Record<string, number>)

                      return (
                        <div className="mt-3">
                          <h5 className="text-sm font-semibold mb-1">
                            Alerts ({total}) • Last update: {msg.alerts && msg.alerts[0]?.updateTime ? new Date(msg.alerts[0].updateTime).toLocaleString() : 'N/A'}
                          </h5>

                          <div className="text-xs text-slate-600 mb-2">
                            severity → {Object.entries(severityCounts).map(([k, v]) => `${k}: ${v}`).join(", ")}
                            {"  "} | status → {Object.entries(statusCounts).map(([k, v]) => `${k}: ${v}`).join(", ")}
                          </div>

                          <ul className="pl-0 space-y-2">
                            {(msg.alerts ?? []).map((a, i) => (
                              <li key={i} className="text-xs border rounded p-2">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="px-1.5 py-0.5 rounded bg-yellow-100 text-yellow-800 border border-yellow-200">
                                    {a.severity}
                                  </span>
                                  <span className="font-medium break-words">
                                    {(a.event || "").replace("CountConstraintComponent(", "").replace(")", "")}
                                  </span>
                                </div>
                                <div className="text-[11px] text-slate-500 mt-1">
                                  asset: …{a.resource?.slice(-8)} | status: {a.status} | at {new Date(a.createTime).toLocaleTimeString()}
                                </div>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )
                    })()}

                  </div>
                </div>
              );
            })}



            {loading && (
              <div className="flex justify-start">
                <div
                  className={`max-w-[75%] p-4 rounded-2xl shadow-sm border font-mono transition-colors
        ${chatBgTheme === 'white'
                      ? 'bg-gray-100 border-gray-300 text-gray-800'
                      : 'bg-gradient-to-b from-neutral-800/80 to-neutral-900/70 border-white/10 text-emerald-200 bubble-crt'}
      `}
                >
                  <div className="mb-1 flex items-center gap-2">
                    <span
                      className={`inline-flex items-center justify-center rounded-full px-2 py-0.5 text-[10px] font-medium
            ${chatBgTheme === 'white'
                          ? 'bg-gray-300 text-gray-800'
                          : 'bg-indigo-500/20 text-indigo-200'}
          `}
                    >
                      XANA
                    </span>
                  </div>

                  <span
                    className={`${chatBgTheme === 'white'
                      ? 'text-gray-700'
                      : 'text-emerald-200 drop-shadow-[0_0_8px_rgba(16,185,129,.25)]'}
          animate-pulse`}
                  >
                    [ Thinking… ]
                  </span>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Prompt */}
          <div
            className={`sticky bottom-0 px-3 py-2 border-t backdrop-blur-md shadow-[0_-6px_20px_-8px_rgba(0,0,0,0.5)]
    ${chatBgTheme === 'white'
                ? 'bg-white border-gray-200'
                : 'bg-neutral-900/40 border-white/10'}
  `}
          >
            <div className="max-w-5xl mx-auto">
              <PromptBox
                onSubmit={handlePromptSubmit}
                theme={chatBgTheme} // pass theme down
              />
            </div>
          </div>
        </main>
      )}
    </>
  );
}
