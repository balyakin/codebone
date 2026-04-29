package main

import "fmt"

type Server struct {
  Port int
}

func (s *Server) Start() {
  fmt.Println(s.Port)
}

func NewServer() *Server {
  return &Server{Port: 8080}
}
