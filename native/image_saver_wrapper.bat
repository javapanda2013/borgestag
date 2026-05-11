@echo off
:: image_saver_wrapper.bat
:: Launched by Firefox Native Messaging to start the Python host.
:: Keep this file in the same folder as image_saver.py

python "%~dp0image_saver.py"
