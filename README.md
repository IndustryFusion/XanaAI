# Xana AI - Industrial Machine Support Assistant
[![FOSSA Status](https://app.fossa.com/api/projects/git%2Bgithub.com%2FIndustryFusion%2FXanaAI.svg?type=shield)](https://app.fossa.com/projects/git%2Bgithub.com%2FIndustryFusion%2FXanaAI?ref=badge_shield)


**Xana AI** is an intelligent chatbot platform designed for shop-floor operators and technicians to interact with industrial machines. Built with Next.js (frontend) and NestJS (backend), it leverages RAG (Retrieval-Augmented Generation), vector embeddings, and LLM-powered conversational AI to provide contextual machine support, live data visualization, and alert monitoring.

---

## 🚀 Features

### Frontend (Next.js)
- **Conversational Chat Interface**: Interactive chat UI with markdown support and syntax highlighting
- **Multi-Asset Selection**: Choose specific machines or query across all available assets
- **Live Data Visualization**: Real-time chart rendering using Chart.js for time-series metrics
- **Alert Monitoring**: Display machine alerts with severity, status, and timestamps
- **Theme Support**: Dark and light mode toggle for user preference
- **Authentication**: Token-based authentication integrated with IFF (IndustryFusion) suite
- **Responsive Design**: Built with Tailwind CSS and Radix UI components

### Backend (NestJS)
- **RAG-Powered Query Service**: Semantic search using Milvus vector database with BGE-M3 embeddings
- **LLM Integration**: Meta LLaMA 3.3 70B Instruct model via IONOS Cloud API & Qwen2.5-14B-Instruct-fp16-ov via OpenVINO model server running on Intel dGPU like Battlemage or on CPU
- **Intent Detection**: Automatically detects chart and alert requests using structured LLM outputs
- **Live Data Fetching**: PostgreSQL TimescaleDB integration for historical machine metrics
- **Alert Integration**: Real-time alert retrieval from Alerta API
- **Vector Store Management**: MongoDB-based asset-to-vector-store mapping
- **Security**: JWT token handling with encryption/masking for sensitive data
- **CORS & API Gateway**: Configurable CORS and REST endpoints

---

## 📁 Project Structure

```
XanaAI/
├── backend/                    # NestJS REST API
│   ├── src/
│   │   ├── endpoints/
│   │   │   ├── query/         # Main query service with RAG
│   │   │   ├── ionos-rest/    # LLM & embedding API client IONOS
|   |   |   ├── opea-rest      # LLM & embedding API using OpenVINO server running on Intel 
|   |   |   ├── ollama-rest      # LLM & embedding API client using Ollama running on Intel
│   │   │   └── vector_mapping/ # Asset-to-vector store mapping
│   │   ├── data/jsonld/       # JSON-LD machine schemas
│   │   └── main.ts            # App entry (port 4050)
│   └── package.json
│
├── frontend/                   # Next.js application
│   ├── src/
│   │   ├── app/
│   │   │   └── page.tsx       # Main chat interface
│   │   ├── components/
│   │   │   ├── PromptBox.tsx  # User input component
│   │   │   └── AlertSummaryBlock.tsx
│   │   └── utility/tools.ts   # Helper functions
│   └── package.json
│
└── README.md
```

---

## 🛠️ Tech Stack

### Backend
- **Framework**: NestJS (Node.js)
- **LLM**: Meta LLaMA 3.3 70B Instruct (via IONOS Cloud) OR Qwen2.5-14B-Instruct-fp16-ov via OpenVINO model server running on Intel dGPU like Battlemage or 0n CPU
- **Embeddings**: BAAI/bge-m3 (1024-dim vectors)
- **Vector DB**: Milvus (semantic search)
- **Time-Series DB**: PostgreSQL/TimescaleDB
- **Alert System**: Alerta API
- **Metadata Store**: MongoDB
- **Authentication**: JWT with JOSE encryption

### Frontend
- **Framework**: Next.js 15 (React 18)
- **Styling**: Tailwind CSS 4, Radix UI
- **Charts**: Chart.js, PrimeReact
- **Markdown**: react-markdown with remark-gfm
- **HTTP Client**: Axios

---

## ⚙️ Setup & Installation

### Prerequisites
- Node.js 20+
- PostgreSQL (TimescaleDB)
- MongoDB
- Milvus vector database
- Alerta instance (optional, for alerts)

### Backend Setup

1. **Navigate to backend directory**
   ```bash
   cd backend
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment variables looking .env.example**  
   Create a `.env` file:
   ```env
   # API Keys
   COMPLETIONS_API_KEY=your_ionos_api_key
   COMPLETIONS_API_URL=https://inference.de-txl.ionos.com
   
   #OPEA OVMS Configuration (when LLM_PROVIDER="opea-ovms")
   OPEA_LLM_URL=http://localhost:8000/v3/chat/completions
   OPEA_LLM_MODEL=Qwen2.5-14B-Instruct-fp16-ov
   OPEA_CHAT_TIMEOUT=1800000  # 30 minutes

   # PostgreSQL (TimescaleDB)
   PGHOST=your_postgres_host
   PGPORT=5432
   PGPASSWORD=your_password
   PG_TABLE=entityhistory
   PGSSL=true
   
   # MongoDB
   MONGODB_URI=mongodb://localhost:27017
   MONGODB_DB=admin
   MONGODB_COL=vector_store_mappings
   
   # Milvus
   MILVUS_COLLECTION_NAME=custom_setup_6
   RAG_EMBED_DIM=1024
   
   # Alerta
   ALERTA_API_URL=https://alerta.example.com/api/alerts
   ALERTA_API_KEY=your_alerta_key
   
   # Security
   SECRET_KEY=your_jwt_secret
   MASK_SECRET=your_mask_secret
   REGISTRY_URL=https://registry.example.com
   
   # CORS
   CORS_ORIGIN=http://localhost:3050
   ```

4. **Start development server**
   ```bash
   npm run start:dev
   ```
   - Backend runs on `http://localhost:4050`

### Frontend Setup

1. **Navigate to frontend directory**
   ```bash
   cd frontend
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment variables**  
   Create a `.env.local` file:
   ```env
   NEXT_PUBLIC_API_BASE=http://localhost:4050
   ```

4. **Start development server**
   ```bash
   npm run dev
   ```
   - Frontend runs on `http://localhost:3050`

---

## 🔧 Development Notes

### Skip Authentication (Dev Mode)
In `frontend/src/app/page.tsx` (line ~70), change:
```typescript
setLogin(false) → setLogin(true)
```

### Key API Endpoints

**Backend Routes:**
- `POST /query` - Main chat query with RAG
- `GET /vector-mappings` - List available assets
- `POST /auth/get-indexed-db-data` - Retrieve indexed user data
- `POST /ai/chat` - Direct LLM completion (for testing)

**Frontend Flow:**
1. User authenticates via IFF token (URL param)
2. Loads available machines from `/vector-mappings`
3. Sends messages to `/query` with selected assets
4. Displays LLM response, charts, and alerts

---

## 🧠 How It Works

### RAG Pipeline
1. **User Query** → Sent to backend with conversation history
2. **Intent Detection** → LLM determines if chart/alert data is needed
3. **Vector Search** → User question embedded → Milvus retrieves relevant docs
4. **Context Injection** → Search results added to system prompt
5. **LLM Response** → LLaMA generates answer using machine docs + context
6. **Live Data** → If chart/alert intent detected, fetches from Postgres/Alerta
7. **Frontend Rendering** → Displays text + charts + alerts


## 🚀 Production Deployment

### Backend
```bash
npm run build
npm run start:prod
```

### Frontend
```bash
npm run build
npm run start
```

### Docker Support
Dockerfiles are included in both `backend/` and `frontend/` directories.

---

## 📝 License

This project is licensed under the terms specified in the [LICENSE](LICENSE) file.

---


[![FOSSA Status](https://app.fossa.com/api/projects/git%2Bgithub.com%2FIndustryFusion%2FXanaAI.svg?type=large)](https://app.fossa.com/projects/git%2Bgithub.com%2FIndustryFusion%2FXanaAI?ref=badge_large)

## 🤝 Contributing

Developed and maintained by **IndustryFusion**.  
For issues or feature requests, please contact the development team.

---

## 🔗 Related Resources

- [NestJS Documentation](https://nestjs.com/)
- [Next.js Documentation](https://nextjs.org/docs)
- [Milvus Vector Database](https://milvus.io/)
- [IONOS Cloud AI](https://cloud.ionos.com/)
- [Meta LLaMA Models](https://ai.meta.com/llama/)