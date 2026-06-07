{{- define "swedish-competition-mcp.fullname" -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "swedish-competition-mcp.labels" -}}
app.kubernetes.io/name: swedish-competition-mcp
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: ansvar-mcp-fleet
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{- define "swedish-competition-mcp.selectorLabels" -}}
app.kubernetes.io/name: swedish-competition-mcp
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
