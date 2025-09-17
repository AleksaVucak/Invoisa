
# Invoisa (Full Stack)

## Backend
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000

## Frontend
cd frontend
npm install
# Terminal A:
npm run build:css
# Terminal B:
npm run dev
