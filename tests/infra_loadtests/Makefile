loki:
	kubectl port-forward --namespace monitoring deployment/loki-read 3100:3100 & echo -n "$$!" > portforward.pid
	sleep 2
	k6 run loki-read.js
	cat portforward.pid | xargs kill 
	rm portforward.pid