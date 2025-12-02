# OPEA Integration with OpenVINO Model Server (OVMS)

This module provides integration with Intel's OPEA (Open Platform for Enterprise AI) using OpenVINO Model Server (OVMS) as the backend for LLM serving, embeddings, and reranking. This readme is about running models on Intel B60 Arc Series GPUs 

## Overview

The OPEA-OVMS service supports three main functionalities:
- **LLM Chat Completion** - Text generation using optimized LLMs
- **Embeddings** - Vector embeddings for semantic search
- **Reranking** - Document reranking for improved retrieval quality

All services are powered by OpenVINO Model Server for optimized inference on Intel hardware.

## Architecture

```
┌─────────────────┐
│  XANA Backend   │
│  (NestJS)       │
└────────┬────────┘
         │
         ├──────────────────────────────────────┐
         │                                      │
         ▼                                      ▼
┌────────────────┐                    ┌────────────────┐
│ OpeaService    │                    │ Extract/RAG    │
│                │◄───────────────────┤ Services       │
└────────┬───────┘                    └────────────────┘
         │
         │ HTTP/REST
         │
         ▼
┌─────────────────────────────────────────────────┐
│     OpenVINO Model Server (OVMS)                │
│                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐       │
│  │   LLM    │  │Embedding │  │ Reranker │       │
│  │ Service  │  │ Service  │  │ Service  │       │
│  └──────────┘  └──────────┘  └──────────┘       │
└─────────────────────────────────────────────────┘
```

---

## 🐳 OVMS Docker Installation & Setup

### Prerequisites
- Docker 20.10+
- Docker Compose 2.0+
- 32GB+ RAM recommended
- Intel GPU (for optimal XPU performance with OpenVINO) + CPU

### Quick Start

We provide a complete Docker setup with all three services (LLM, Embedding, Reranking).
For better understanding of running OVMS as backend server, check github and documentation of OVMS [https://docs.openvino.ai/2025/model-server/ovms_what_is_openvino_model_server.html]

```bash
# 1. Convert models to OpenVINO format (if not already done) to use as serving model, Qwen2.5 14B OpenVINO model(Qwen2.5-14B-Instruct-fp16-ov) shows good performance to size ratio
## Convert models does this conversion from modelserver github repos python file
git pull https://github.com/openvinotoolkit/model_server.git
cd model_server/demos/common/export_models
# Make target device GPU(Hetro if multiple), CPU
python export_model.py text_generation --source_model OpenVINO/Qwen2.5-14B-Instruct-fp16-ov --model_name OpenVINO/Qwen2.5-14B-Instruct-fp16-ov   --weight-format fp16 --model_repository_path /home/models --target_device HETERO:GPU.0,GPU.1 --pipeline_type LM
 ### modify graph.pbtx for LM_CB
  vi ../Meta-Llama-3-8B-Instruct/graph.pbtxt

## convert embedding model:
python export_model.py embeddings --source_model BAAI/bge-m3 --weight-format int8 --config_file_path models/config_embeddings.json --model_repository_path /home/models --target_device CPU

## convert re-ranking model:
 python export_model.py rerank_ov --source_model BAAI/bge-reranker-v2-m3 --weight-format int8 --config_file_path /home/models/config.json --model_repository_path /home/models

# 3. Start all OVMS services docker containers

#Run for OVMS llm Serving using model you want to use. Use target device as you used while exporting model
docker run --device /dev/dri -d  --restart=unless-stopped  --name llm-ovms-server-qwen-14B -p 8000:8000 -u 0 -v /home/models/OpenVINO/Qwen2.5-14B-Instruct-fp16-ov:/model:ro openvino/model_server:2025.3-gpu --rest_port 8000 --model_name OpenVINO/Qwen2.5-14B-Instruct-fp16-ov --model_path /model 

# run for embeding on cpu with choice of model you want
docker run -d --rm -p 6000:6000 --name ovms-embedding-serving -v /home/models/BAAI/bge-m3:/model:ro openvino/model_server:2025.3-gpu  --rest_port 6000 --model_name BAAI/bge-m3  --model_path /model

# run for re-ranker on cpu with choice of model you prefer
docker run -d --rm -p 8001:8001 --name ovms-reranking-serving -v /home/models/BAAI/bge-reranker-v2-m3:/model:ro openvino/model_server:2025.3-gpu  --rest_port 8001 --model_name BAAI/bge-reranker-v2-m3  --model_path /model
```

**Check status:**
```bash
docker ps
docker logs ovms-llm-server
docker logs ovms-embedding-serving
docker logs ovms-reranking-serving
```

---

# test with curl
## 1. LLM service

```bash
curl -s http://localhost:8000/v3/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "OpenVINO/Qwen2.5-14B-Instruct-fp16-ov",
    "max_tokens": 30,
    "temperature": 0,
    "stream": false,
    "messages": [
      { "role": "system", "content": "You are a helpful assistant." },
      { "role": "user", "content": "What are the 3 main tourist attractions in Paris?" }
    ]
  }' | jq .
```

## 2. Embedding Service (Port 8010-8011)
```bash
 docker run -d -p 6000:6000  --restart=unless-stopped --name ovms-embedding-server -v /home/models/BAAI/bge-m3:/model:ro openvino/model_server:2025.3-gpu  --rest_port 6000 --model_name BAAI/bge-m3  --model_path /model 


curl http://localhost:6000/v3/embeddings -H "Content-Type: application/json" -d "{ \"model\": \"BAAI/bge-m3\", \"input\": \"hello world\"}"
```



## 3. Reranking Service (Port 8020-8021)
```bash
docker run -d -p 8001:8001 --restart=unless-stopped --name ovms-reranking-serving -v /home/models/BAAI/bge-reranker-v2-m3:/model:ro openvino/model_server:2025.3-gpu  --rest_port 8001 --model_name BAAI/bge-reranker-v2-m3  --model_path /model 


curl http://localhost:8001/v3/rerank \
         -X POST \
         -H 'Content-Type: application/json' \
         -d '{ "model": "BAAI/bge-reranker-v2-m3", "query": "welcome", "documents":["Deep Learning is not...", "Deep learning is..."]}'

```
# Configure .env of backend according to above models and ports while using opea-ovms serving
  - Edit backend/.env files to match your model paths and ports


