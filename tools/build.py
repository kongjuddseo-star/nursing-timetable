"""tools/app.src.html + static/solver.js → static/app.html (서버용 화면)"""
import os
B = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
html = open(os.path.join(B, 'tools/app.src.html'), encoding='utf-8').read()
solver = open(os.path.join(B, 'static/solver.js'), encoding='utf-8').read()
html = html.replace('/*STATE*/', 'null', 1).replace('/*SOLVER*/', solver, 1)
html = html.replace('<script id="state" type="application/json">', '<script>window.TT_HOST = "server";</script>\n<script id="state" type="application/json">', 1)
open(os.path.join(B, 'static/app.html'), 'w', encoding='utf-8').write(html)
print('static/app.html 만듦')
