library(CardioCurveR)
library(data.table)

d <- fread("R/josefa-antonia-fernandez.csv")

fit <- estimate_RRi_curve(time = d[["Timestamp (s)"]], RRi = d[["RR Interval (ms)"]])

fit$data[,2:3] |>
  matplot(x = d$time, type = "l", lty = 1, lwd = 1:2, axes = FALSE)
axis(1); axis(2)

summary(fit)
plot(fit)
