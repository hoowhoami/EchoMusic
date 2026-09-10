package main

import (
	"bytes"
	"fmt"
	"log"
	"net/http"
	"os"
	"sync"
	"time"
)

func main() {
	const fileSize = 5 * 1024 * 1024
	mockData := make([]byte, fileSize)

	for i := range mockData {
		mockData[i] = byte(i % 256)
	}

	var (
		chaosCounter int
		chaosMutex   sync.Mutex
	)

	http.HandleFunc("/test.mp3", func(w http.ResponseWriter, r *http.Request) {
		log.Printf("[Mock Access] Range: %s", r.Header.Get("Range"))
		reader := bytes.NewReader(mockData)
		http.ServeContent(w, r, "test.mp3", time.Now(), reader)
	})

	http.HandleFunc("/seek_test.aac", func(w http.ResponseWriter, r *http.Request) {
		data, err := os.ReadFile("assets/seek_test.aac")
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		log.Printf("[Audio Access] Range: %s", r.Header.Get("Range"))
		http.ServeContent(w, r, "seek_test.aac", time.Now(), bytes.NewReader(data))
	})

	http.HandleFunc("/chaos.mp3", func(w http.ResponseWriter, r *http.Request) {
		chaosMutex.Lock()

		if r.Header.Get("Range") == "bytes=0-" {
			chaosCounter = 0
		}

		chaosCounter++
		count := chaosCounter
		chaosMutex.Unlock()

		log.Printf("[Chaos Access] Count: %d | Range: %s", count, r.Header.Get("Range"))

		if count == 2 || count == 3 {
			w.Header().Set("Retry-After", "1")
			w.WriteHeader(http.StatusServiceUnavailable)
			w.Write([]byte("Service Temporarily Unavailable"))
			return
		}

		reader := bytes.NewReader(mockData)
		http.ServeContent(w, r, "chaos.mp3", time.Now(), reader)
	})

	port := ":8000"
	fmt.Printf("[i] Mock Server started\n")
	fmt.Printf(" -> Mock URL: http://localhost%s/test.mp3\n", port)
	fmt.Printf(" -> Audio URL: http://localhost%s/seek_test.aac\n", port)
	fmt.Printf(" -> Chaos URL: http://localhost%s/chaos.mp3\n", port)
	log.Fatal(http.ListenAndServe(port, nil))
}
