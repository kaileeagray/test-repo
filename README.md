# Spark Coach Web App

Spark Coach is an AI learning coach web app for kids ages 6-12 with dyslexia and ADHD.

## What it includes

- Parent sign up and sign in (email + password)
- Parent dashboard with all child profiles
- Child profile creation (name, age, 4-digit PIN)
- Child login with simple PIN
- Live child chat session with Spark Coach
- Session summary screen after each session

## Design goals

- Warm, soft colors
- Large readable text (18px+)
- Short, simple UI text
- Lots of whitespace and clear visual grouping

## Tech stack

- Node.js + Express
- SQLite (app data + session store)
- EJS templates
- Optional OpenAI API integration (`OPENAI_API_KEY`)

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:3000`

## Optional AI setup

Set this environment variable to enable real AI responses and summaries:

```bash
export OPENAI_API_KEY="your_api_key_here"
```

Without an API key, Spark Coach uses a friendly built-in fallback responder.
