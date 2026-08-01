from fastapi import FastAPI, Request, Response
from fastapi.templates import Jinja2Templates
from fastapi.middleware.cors import CORSMiddleware

app=FastAPI()
templates=Jinja2Templates(directory="templates")

@app.get("/")
async def home(request: Request):
    return templates.TemplateResponse("First.html", {"request": request})