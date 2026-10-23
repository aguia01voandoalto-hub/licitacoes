#!/usr/bin/env python3
"""Copia produto.html para site/index.html, a pasta que a Vercel publica.

Rode depois de qualquer mudança em produto.html e faça commit de site/index.html.
"""
import os, shutil

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.makedirs(os.path.join(RAIZ, "site"), exist_ok=True)
shutil.copyfile(os.path.join(RAIZ, "produto.html"), os.path.join(RAIZ, "site", "index.html"))
print("site/index.html atualizado")
